import { db } from "@autonoma/db";
import {
    DeployedComparison,
    type ReconciledAnalysisFinding,
    dedupeAnalysisFindings,
    persistInvestigationCosts,
} from "@autonoma/investigation";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type {
    AnalysisCandidateFinding,
    ReconcileAnalysisInput,
    ReconcileAnalysisOutput,
} from "@autonoma/workflow/activities";

const CLIENT_BUG = "client_bug";

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
 * Reconciler stage. Holistically deduplicates the Investigators' candidate findings (several tests can surface
 * the same underlying issue), unioning each group's evidence into one finding; derives the shadow verdict from
 * the deduped set; produces the shadow-vs-diffs DeployedComparison (reading the authoritative diffs job for the
 * twin's head SHA); and persists all of it to the shadow store (`AnalysisShadowRun`) - an isolated island that
 * is never a user-facing Bug/Issue. It is single-concern: no plan edits, no deletions, no re-runs, no finalize.
 * Filing real bugs stays dormant behind authoritative mode until the cutover ships.
 */
export async function reconcileAnalysis(
    input: ReconcileAnalysisInput,
    dedupe: AnalysisDedupe = holisticDedupe,
): Promise<ReconcileAnalysisOutput> {
    const { snapshotId, mode, candidates } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "reconcileAnalysis", extra: { mode, candidateCount: candidates.length } });
    logger.info("Reconciler stage started");

    const findings = await dedupe(candidates, snapshotId, logger);
    const clientBugCount = findings.filter((finding) => finding.category === CLIENT_BUG).length;
    const testCount = candidates.length;
    const findingCount = findings.length;
    // Two-plane verdict, app-health plane only in this slice: a PR is `client_bug` if any finding is one.
    const verdict = clientBugCount > 0 ? CLIENT_BUG : "passed";
    logger.info("Deduped candidate findings", { extra: { testCount, findingCount, clientBugCount } });

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
    return { verdict, testCount, findingCount, clientBugCount, comparison, filedCount: 0 };
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
            model: session.getModel({ model: "classifier", tag: "analysis-reconcile-dedup" }),
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

interface PersistShadowRunInput {
    snapshotId: string;
    organizationId: string;
    mode: string;
    verdict: string;
    testCount: number;
    clientBugCount: number;
    findings: ReconciledAnalysisFinding[];
    comparison: ReconcileAnalysisOutput["comparison"];
}

/**
 * Upsert the shadow run record - keyed by the twin snapshot so a re-run overwrites rather than duplicates. The
 * deduped findings are stored as a display blob (each with its unioned `coveredSlugs` + `members`); nothing
 * user-facing FKs into this row.
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
        })),
    }));
    const data = {
        mode: input.mode,
        verdict: input.verdict,
        testCount: input.testCount,
        clientBugCount: input.clientBugCount,
        findings,
        deployed: input.comparison,
    };
    await db.analysisShadowRun.upsert({
        where: { snapshotId: input.snapshotId },
        create: { snapshotId: input.snapshotId, organizationId: input.organizationId, ...data },
        update: data,
    });
    logger.info("Persisted shadow analysis run", { extra: { findingCount: findings.length } });
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
