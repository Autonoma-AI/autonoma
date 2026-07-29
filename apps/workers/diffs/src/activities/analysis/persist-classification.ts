import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
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

    const findingId = await db.$transaction(async (tx) => {
        const finding = await tx.analysisFinding.upsert({
            where: { reportSnapshotId_testCaseId: { reportSnapshotId: snapshotId, testCaseId } },
            create: { reportSnapshotId: snapshotId, testCaseId, organizationId, origin, selectionReason },
            // The per-test facts are settled at selection, so a later iteration restates rather than revises them.
            update: {},
            select: { id: true },
        });

        const fields = buildClassificationFields(classification);
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

/**
 * The classification's own columns. The rich evidence rides from the classifier's `report`; a contained fault has
 * none (no classifier ran), so it lands as a category and a headline with every verdict field absent.
 */
function buildClassificationFields(classification: AnalysisCandidateClassification) {
    const report = classification.report;
    return {
        generationId: classification.generationId,
        category: classification.category,
        headline: classification.headline,
        confidence: report?.confidence,
        expectedBehavior: report?.expectedBehavior,
        actualBehavior: report?.actualBehavior,
        whatHappened: report?.whatHappened,
        planMismatchNote: report?.planMismatchNote,
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
