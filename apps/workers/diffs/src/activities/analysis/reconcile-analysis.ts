import { type Prisma, db } from "@autonoma/db";
import {
    type CoverageSummary,
    type ReconciledAnalysisFinding,
    type TwoPlaneSummary,
    dedupeAnalysisFindings,
    narrateAnalysis,
    persistInvestigationCosts,
    summarizeVerdictPlanes,
} from "@autonoma/diffs/analysis";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { ANALYSIS_VERDICT } from "@autonoma/types";
import type {
    AnalysisCandidateFinding,
    ReconcileAnalysisInput,
    ReconcileAnalysisOutput,
} from "@autonoma/workflow/activities";

const CLIENT_BUG = ANALYSIS_VERDICT.client_bug;
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
 * Reconciler stage - the single cross-test writer. Holistically deduplicates the Investigators' candidate
 * findings (several tests can surface the same underlying issue), unioning each group's evidence into one
 * finding; derives the DETERMINISTIC two-plane verdict from the deduped set (app-health headline +
 * coverage-confidence summary) in code, then narrates it with a constrained model call that cannot alter it; and
 * persists the whole run to the rich store (`AnalysisReport` + per-test `AnalysisFinding` rows, carrying every
 * candidate's evidence, media keys, and the Impact Analysis reasoning).
 *
 * It files NO user-facing rows: the `AnalysisFinding` store is the single source of truth for every finding,
 * `client_bug` included (it carries its full evidence on the row). `client_bug` is still the app-health plane and
 * still drives the headline verdict - it just is not copied into `Bug`/`Issue`.
 */
export async function reconcileAnalysis(
    input: ReconcileAnalysisInput,
    deps: ReconcileDeps = {},
): Promise<ReconcileAnalysisOutput> {
    const { snapshotId, candidates, impactReasoning } = input;
    const dedupe = deps.dedupe ?? holisticDedupe;
    const narrate = deps.narrate ?? defaultNarrate;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "reconcileAnalysis", extra: { candidateCount: candidates.length } });
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
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: { branch: { select: { organizationId: true } } },
    });
    if (snapshot == null) throw new Error(`Snapshot ${snapshotId} not found; cannot reconcile the analysis run`);
    const organizationId = snapshot.branch.organizationId;

    await persistAnalysisReport(
        {
            snapshotId,
            organizationId,
            verdict,
            testCount,
            clientBugCount,
            findings,
            coverage,
            narration,
            impactReasoning,
        },
        logger,
    );

    logger.info("Reconciler stage finished", { extra: { findingCount } });
    return {
        verdict,
        testCount,
        findingCount,
        clientBugCount,
        coverageFindingCount: coverage.total,
        unestablishedProposedCount: coverage.unestablishedProposed,
        obsoleteRemovedCount: coverage.obsoleteRemoved,
        narrated: narration != null,
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

interface PersistAnalysisReportInput {
    snapshotId: string;
    organizationId: string;
    verdict: string;
    testCount: number;
    clientBugCount: number;
    findings: ReconciledAnalysisFinding[];
    coverage: CoverageSummary;
    narration?: string;
    impactReasoning?: string;
}

/**
 * Persist the run to the rich store, keyed by snapshot so a re-run overwrites rather than duplicates: upsert the
 * `AnalysisReport` header (verdict, counts, coverage, narration, Impact Analysis reasoning) and replace its child
 * `AnalysisFinding` rows wholesale (the deduped set, each carrying its representative candidate's rich evidence +
 * media keys + the union `coveredSlugs`). One transaction so the header and its findings are always consistent.
 * This is the queryable home the UI reads.
 */
async function persistAnalysisReport(input: PersistAnalysisReportInput, logger: Logger): Promise<void> {
    const reportFields = {
        verdict: input.verdict,
        testCount: input.testCount,
        clientBugCount: input.clientBugCount,
        coverage: input.coverage,
        narration: input.narration,
        impactReasoning: input.impactReasoning,
    };
    await db.$transaction(async (tx) => {
        await tx.analysisReport.upsert({
            where: { snapshotId: input.snapshotId },
            create: { snapshotId: input.snapshotId, organizationId: input.organizationId, ...reportFields },
            update: reportFields,
        });
        // Replace children wholesale: a re-run's row set always mirrors the latest classification.
        await tx.analysisFinding.deleteMany({ where: { reportSnapshotId: input.snapshotId } });
        if (input.findings.length > 0) {
            await tx.analysisFinding.createMany({
                data: buildFindingRows(input.snapshotId, input.organizationId, input.findings),
            });
        }
    });
    logger.info("Persisted analysis report", {
        extra: {
            findingCount: input.findings.length,
            narrated: input.narration != null,
            impactReasoned: input.impactReasoning != null,
        },
    });
}

/**
 * Map each deduped finding to an `AnalysisFinding` row (modeled on InvestigationFinding). `findingKey` is the
 * stable per-report routing id: the anchor slug, suffixed on the rare collision so the `(report, findingKey)`
 * unique never trips. The rich fields come from the finding's report; `planEdited`/`origin` from the anchor
 * member - a merged group is single-category by construction, so every member shares the verdict and the anchor
 * is representative. `coveredSlugs` is set only on a merged finding (length > 1); a standalone one carries just
 * its own `slug`.
 */
function buildFindingRows(
    snapshotId: string,
    organizationId: string,
    findings: ReconciledAnalysisFinding[],
): Prisma.AnalysisFindingCreateManyInput[] {
    const keyCounts = new Map<string, number>();
    return findings.map((finding, index) => {
        const slug = finding.coveredSlugs[0] ?? "unknown";
        const seen = keyCounts.get(slug) ?? 0;
        keyCounts.set(slug, seen + 1);
        const findingKey = seen === 0 ? slug : `${slug}-${seen + 1}`;

        const representative = finding.members[0];
        const report = finding.report;
        return {
            reportSnapshotId: snapshotId,
            organizationId,
            findingKey,
            slug,
            category: finding.category,
            confidence: report?.confidence,
            headline: finding.headline,
            expectedBehavior: report?.expectedBehavior,
            actualBehavior: report?.actualBehavior,
            whatHappened: report?.whatHappened,
            observedAppIssues: report?.observedAppIssues,
            remediation: report?.remediation,
            rootCause: report?.rootCause,
            falsePositiveRisk: report?.falsePositiveRisk,
            plan: report?.plan,
            runSuccess: report?.runSuccess,
            stepCount: report?.stepCount,
            planEdited: representative?.planEdited,
            origin: representative?.origin,
            runSteps: report?.runSteps,
            runTrace: report?.runTrace,
            evidence: report?.evidence,
            // These carry the raw s3:// keys (the API signs them on read), not URLs.
            videoKey: report?.videoKey,
            optimizedVideoKey: report?.optimizedVideoKey,
            screenshotKey: report?.screenshotKey,
            clipKey: report?.clipKey,
            classificationConversationUrl: report?.classificationConversationUrl,
            error: report?.error,
            coveredSlugs: finding.coveredSlugs.length > 1 ? finding.coveredSlugs : undefined,
            displayOrder: index,
        };
    });
}
