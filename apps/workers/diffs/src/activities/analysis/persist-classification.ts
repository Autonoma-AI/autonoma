import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { TestSuiteStore } from "@autonoma/test-suite";
import type {
    AnalysisCandidateClassification,
    PersistAnalysisClassificationInput,
    PersistAnalysisClassificationOutput,
} from "@autonoma/workflow/activities";

/**
 * File one run+classify iteration onto the run's store: find or create this test's `AnalysisFinding`, record the
 * iteration as its own `AnalysisClassification`, and repoint the finding at it as the verdict the run stands behind.
 *
 * Appending is the whole point. The Investigator calls this after EVERY iteration, so a self-heal's superseded
 * verdict - the one that authored the rewrite, with its own evidence and its own classifier conversation - stays on
 * disk instead of being overwritten by the pass that follows it. One iteration never overwrites another.
 *
 * Which slot it appends to is the CALLER's iteration counter, not a count of what is already stored, so filing the
 * same iteration twice restates that one row. That matters because several readers infer a self-heal from the
 * number of classifications a test has: a duplicated row would report a plan rewrite that never happened.
 *
 * All three writes share one transaction: a finding that exists but points at no classification, or a classification
 * the finding does not point at, would both read as a test that was never judged.
 */
export async function persistAnalysisClassification(
    input: PersistAnalysisClassificationInput,
): Promise<PersistAnalysisClassificationOutput> {
    const { snapshotId, testCaseId, origin, selectionReason, number, classification } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only the non-canonical
    // testCase/category go in `extra`.
    const logger = rootLogger.child({
        name: "persistAnalysisClassification",
        extra: { testCaseId, number, category: classification.category },
    });
    logger.info("Persisting analysis classification");

    // BranchSnapshot inherits its org from its branch; the finding's denormalized org backs its cross-run index.
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: { branch: { select: { organizationId: true } } },
    });
    if (snapshot == null) throw new Error(`Snapshot ${snapshotId} not found; cannot persist the classification`);
    const organizationId = snapshot.branch.organizationId;

    const generationId = classification.generationId ?? (await resolveContainmentRun(snapshotId, testCaseId, logger));

    const findingId = await db.$transaction(async (tx) => {
        const finding = await tx.analysisFinding.upsert({
            where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId } },
            create: { reportSnapshotId: snapshotId, testCaseId, organizationId, origin, selectionReason },
            // The per-test facts are settled at selection, so a later iteration restates rather than revises them.
            update: {},
            select: { id: true },
        });

        const fields = buildClassificationFields(classification, generationId);
        const filed = await tx.analysisClassification.upsert({
            where: { findingId_number: { findingId: finding.id, number } },
            create: { findingId: finding.id, number, organizationId, ...fields },
            update: fields,
            select: { id: true },
        });
        await tx.analysisFinding.update({
            where: { id: finding.id },
            data: { currentClassificationId: filed.id },
        });

        return finding.id;
    });

    logger.info("Persisted analysis classification");
    return { findingId, number };
}

/** What a containment run that never executed is marked failed with. */
const CONTAINMENT_RUN_FAILURE_MESSAGE = "The Investigator crashed before this test's run could execute";

/**
 * The run a containment classification lands on when the caller does not know one: the fan-out parent contains a
 * child that started its own runs and crashed, so the parent cannot name the run it died on. The test's newest run
 * on the snapshot is the honest anchor; a child that crashed before starting any run gets one started - and
 * immediately marked failed - purely so the classification has a run to hang off, since
 * `AnalysisClassification.generationId` is required.
 */
async function resolveContainmentRun(snapshotId: string, testCaseId: string, logger: Logger): Promise<string> {
    const newest = await db.testGeneration.findFirst({
        where: { snapshotId, testPlan: { testCaseId } },
        orderBy: { createdAt: "desc" },
        select: { id: true },
    });
    if (newest != null) {
        logger.info("Containment classification resolved to the test's newest run", {
            extra: { testCaseId, generationId: newest.id },
        });
        return newest.id;
    }

    const store = new TestSuiteStore(db);
    const snapshot = await store.reopen(snapshotId);
    // Started and failed in one transaction: a run that committed `pending` and never got its outcome would sit
    // on the snapshot forever with nothing left to execute it.
    const runId = await snapshot.withTransaction(async (open, tx) => {
        const { runId } = await open.startRun(testCaseId);
        await tx.testGeneration.update({
            where: { id: runId },
            data: { status: "failed", failure: { kind: "engine_error", message: CONTAINMENT_RUN_FAILURE_MESSAGE } },
        });
        return runId;
    });
    logger.warn("Investigator crashed before starting any run; recorded a failed run for its containment", {
        extra: { testCaseId, generationId: runId },
    });
    return runId;
}

/**
 * The classification's own columns. The rich evidence rides from the classifier's `report`; a contained fault has
 * none (no classifier ran), so it lands as a category and a headline with every verdict field absent.
 */
function buildClassificationFields(classification: AnalysisCandidateClassification, generationId: string) {
    const report = classification.report;
    return {
        generationId,
        category: classification.category,
        headline: classification.headline,
        confidence: report?.confidence,
        expectedBehavior: report?.expectedBehavior,
        actualBehavior: report?.actualBehavior,
        whatHappened: report?.whatHappened,
        planMismatchNote: report?.planMismatchNote,
        invalidTestNote: report?.invalidTestNote,
        observedAppIssues: report?.observedAppIssues,
        remediation: report?.remediation,
        rootCause: report?.rootCause,
        falsePositiveRisk: report?.falsePositiveRisk,
        plan: report?.plan,
        runSuccess: report?.runSuccess,
        stepCount: report?.stepCount,
        runSteps: report?.runSteps,
        runTrace: report?.runTrace,
        evidence: report?.evidence,
        // These carry the raw s3:// keys (the API signs them on read), not URLs.
        videoKey: report?.videoKey,
        optimizedVideoKey: report?.optimizedVideoKey,
        screenshotKey: report?.screenshotKey,
        clipKey: report?.clipKey,
        conversationUrl: report?.conversationUrl,
        error: report?.error,
    };
}
