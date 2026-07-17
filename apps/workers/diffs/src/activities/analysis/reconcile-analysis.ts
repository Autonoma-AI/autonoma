import { db } from "@autonoma/db";
import {
    type CoverageSummary,
    DeployedComparison,
    type ReconciledAnalysisFinding,
    type TwoPlaneSummary,
    dedupeAnalysisFindings,
    narrateAnalysis,
    persistInvestigationCosts,
    summarizeVerdictPlanes,
} from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    AnalysisCandidateFinding,
    ReconcileAnalysisInput,
    ReconcileAnalysisOutput,
} from "@autonoma/workflow/activities";

const CLIENT_BUG = "client_bug";
const DEDUP_TAG = "analysis-reconcile-dedup";
const NARRATION_TAG = "analysis-reconcile-narration";

/**
 * How the Reconciler collapses the fan-out's candidates into deduped findings. Injected so tests exercise
 * persistence + verdict derivation deterministically without a live model; the default opens a metered model
 * session and runs the holistic dedup.
 */
export type AnalysisDedupe = (
    candidates: AnalysisCandidateFinding[],
    snapshotId: string,
    logger: Logger,
) => Promise<ReconciledAnalysisFinding[]>;

/**
 * How the Reconciler narrates the finalized two-plane verdict. Injected so tests assert the narration is
 * persisted (and never alters the verdict) deterministically without a live model; the default opens a metered
 * model session and runs the constrained narration.
 */
export type AnalysisNarrator = (
    input: { summary: TwoPlaneSummary; findingCount: number },
    snapshotId: string,
    logger: Logger,
) => Promise<string | undefined>;

/** The Reconciler's injectable model-backed steps - defaulted to the metered live implementations. */
export interface ReconcileDeps {
    dedupe?: AnalysisDedupe;
    narrate?: AnalysisNarrator;
}

/**
 * Reconciler stage. Holistically deduplicates the Investigators' candidate findings (several tests can surface
 * the same underlying issue), unioning each group's evidence into one finding; derives the DETERMINISTIC
 * two-plane verdict from the deduped set (app-health headline + coverage-confidence summary) in code, then
 * narrates it with a constrained model call that cannot alter it; loads the DeployedComparison against the
 * authoritative diffs job for the twin's head SHA; and persists all of it to the shadow store
 * (`AnalysisShadowRun`) - an isolated island that is never a user-facing Bug/Issue. It is single-concern: no
 * plan edits, no deletions, no re-runs, no finalize. Filing real bugs stays dormant behind authoritative mode
 * until the cutover ships. Never throws: every model-backed step is contained.
 */
export async function reconcileAnalysis(
    input: ReconcileAnalysisInput,
    deps: ReconcileDeps = {},
): Promise<ReconcileAnalysisOutput> {
    const { snapshotId, mode, candidates } = input;
    const dedupe = deps.dedupe ?? holisticDedupe;
    const narrate = deps.narrate ?? defaultNarrate;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "reconcileAnalysis", extra: { mode, candidateCount: candidates.length } });
    logger.info("Reconciler stage started");

    const findings = await dedupe(candidates, snapshotId, logger);

    // Derived in code from the finalized findings; the narration below is downstream and cannot change it.
    const summary = summarizeVerdictPlanes(findings);
    const { verdict, coverage } = summary;
    const clientBugCount = findings.filter((finding) => finding.category === CLIENT_BUG).length;
    const testCount = candidates.length;
    const findingCount = findings.length;
    logger.info("Derived two-plane verdict", {
        extra: {
            verdict,
            findingCount,
            clientBugCount,
            coverageFindingCount: coverage.total,
            unestablishedProposed: coverage.unestablishedProposed,
            obsoleteRemoved: coverage.obsoleteRemoved,
        },
    });

    const narration = await narrate({ summary, findingCount }, snapshotId, logger);

    // BranchSnapshot has no organizationId of its own - it inherits the org from its branch.
    const twin = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: { headSha: true, branch: { select: { organizationId: true } } },
    });
    if (twin == null) throw new Error(`Twin snapshot ${snapshotId} not found; cannot reconcile the analysis run`);

    const comparison = await loadComparison(twin.headSha, logger);
    logger.info("Produced DeployedComparison", { extra: comparison });

    await persistShadowRun(
        {
            snapshotId,
            organizationId: twin.branch.organizationId,
            mode,
            verdict,
            testCount,
            clientBugCount,
            findings,
            coverage,
            narration,
            comparison,
        },
        logger,
    );

    if (mode === "authoritative") {
        // Filing real Bug/Issue stays dormant until the authoritative cutover ships; log so an accidental
        // authoritative run is visible.
        logger.warn("Authoritative reconcile is not implemented yet; filing no user-facing rows");
    }

    logger.info("Reconciler stage finished; shadow store written, no user-facing rows filed");
    return {
        verdict,
        testCount,
        findingCount,
        clientBugCount,
        coverageFindingCount: coverage.total,
        unestablishedProposedCount: coverage.unestablishedProposed,
        obsoleteRemovedCount: coverage.obsoleteRemoved,
        narrated: narration != null,
        comparison,
        filedCount: 0,
    };
}

/**
 * The default dedup: open a metered model session and run the holistic clustering, then persist its AI spend.
 * The model session lives in `../../services` (which validates the worker env at import), so it is loaded
 * lazily - importing this activity module (e.g. in a hermetic test) never forces env validation. Contained: any
 * failure to build the session degrades to reporting the candidates un-merged, so a dedup problem can never sink
 * the Reconciler (`dedupeAnalysisFindings` is itself contained for model failures).
 */
async function holisticDedupe(
    candidates: AnalysisCandidateFinding[],
    snapshotId: string,
    logger: Logger,
): Promise<ReconciledAnalysisFinding[]> {
    try {
        const { createModelSession } = await import("../../services");
        const session = createModelSession();
        const findings = await dedupeAnalysisFindings({
            findings: candidates,
            model: session.getModel({ model: "classifier", tag: DEDUP_TAG }),
        });
        // Cost tracking is auxiliary - a transient DB error must not discard the findings we already computed.
        await persistInvestigationCosts(db, snapshotId, session.costCollector, logger).catch((error) => {
            logger.warn("Failed to persist reconcile-dedup costs; keeping the deduped findings", { err: error });
        });
        return findings;
    } catch (error) {
        logger.warn("Dedup model session unavailable; reporting candidates un-merged", { err: error });
        return candidates.map((candidate) => ({
            category: candidate.category,
            headline: candidate.headline,
            coveredSlugs: [candidate.slug],
            members: [candidate],
        }));
    }
}

/**
 * The default narration: open a metered model session and run the constrained narration over the finalized
 * verdict, then persist its AI spend. Lazily imports the session for the same reason as `holisticDedupe`.
 * Contained: a failure to build the session degrades to an omitted narration (`narrateAnalysis` is itself
 * contained for model failures), so a narration problem can never sink the Reconciler.
 */
async function defaultNarrate(
    input: { summary: TwoPlaneSummary; findingCount: number },
    snapshotId: string,
    logger: Logger,
): Promise<string | undefined> {
    try {
        const { createModelSession } = await import("../../services");
        const session = createModelSession();
        const narration = await narrateAnalysis({
            summary: input.summary,
            findingCount: input.findingCount,
            model: session.getModel({ model: "classifier", tag: NARRATION_TAG }),
        });
        await persistInvestigationCosts(db, snapshotId, session.costCollector, logger).catch((error) => {
            logger.warn("Failed to persist reconcile-narration costs; keeping the narration", { err: error });
        });
        return narration;
    } catch (error) {
        logger.warn("Narration model session unavailable; omitting the narration", { err: error });
        return undefined;
    }
}

interface PersistShadowRunInput {
    snapshotId: string;
    organizationId: string;
    mode: string;
    verdict: string;
    testCount: number;
    clientBugCount: number;
    findings: ReconciledAnalysisFinding[];
    coverage: CoverageSummary;
    narration?: string;
    comparison: ReconcileAnalysisOutput["comparison"];
}

/**
 * Upsert the shadow run record - keyed by the twin snapshot so a re-run overwrites rather than duplicates. The
 * deduped findings are stored as a display blob (each with its unioned `coveredSlugs` + `members`); the coverage
 * summary, narration, and DeployedComparison sit alongside. Nothing user-facing FKs into this row.
 */
async function persistShadowRun(input: PersistShadowRunInput, logger: Logger): Promise<void> {
    const findings = input.findings.map((finding) => ({
        category: finding.category,
        headline: finding.headline,
        coveredSlugs: finding.coveredSlugs,
        members: finding.members.map((member) => ({
            slug: member.slug,
            category: member.category,
            headline: member.headline,
            planEdited: member.planEdited,
            origin: member.origin,
        })),
    }));
    const data = {
        mode: input.mode,
        verdict: input.verdict,
        testCount: input.testCount,
        clientBugCount: input.clientBugCount,
        findings,
        coverage: input.coverage,
        narration: input.narration,
        deployed: input.comparison,
    };
    await db.analysisShadowRun.upsert({
        where: { snapshotId: input.snapshotId },
        create: { snapshotId: input.snapshotId, organizationId: input.organizationId, ...data },
        update: data,
    });
    logger.info("Persisted shadow analysis run", {
        extra: { findingCount: findings.length, narrated: input.narration != null },
    });
}

/**
 * The deployed (authoritative diffs) agent's outcome for the twin's head SHA, mapped to the comparison shape.
 * Supplementary and best-effort: a missing diffs job or a query error degrades to `found: false` rather than
 * sinking the run.
 */
async function loadComparison(headSha: string | null, logger: Logger): Promise<ReconcileAnalysisOutput["comparison"]> {
    if (headSha == null) {
        logger.warn("Twin has no head SHA; skipping deployed comparison");
        return { found: false, deployedTestCount: 0 };
    }
    try {
        const deployed = await new DeployedComparison(db).byHeadSha(headSha);
        return { found: deployed.found, jobStatus: deployed.jobStatus, deployedTestCount: deployed.perTest.length };
    } catch (error) {
        logger.warn("Deployed comparison unavailable; returning an empty comparison", { err: error });
        return { found: false, deployedTestCount: 0 };
    }
}
