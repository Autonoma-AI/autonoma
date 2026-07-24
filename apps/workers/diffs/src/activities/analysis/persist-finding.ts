import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { analysisFindingBucket } from "@autonoma/types";
import type {
    AnalysisCandidateFinding,
    PersistAnalysisFindingInput,
    PersistAnalysisFindingOutput,
} from "@autonoma/workflow/activities";

/**
 * Where each presentation bucket sorts in the findings list (bugs first, then the passing checks, then the
 * non-blocking coverage-plane ones). Investigators persist independently, so there is no global insertion index -
 * this bucket rank gives a stable, meaningful default order the report page reads via `displayOrder`.
 */
const BUCKET_DISPLAY_ORDER: Record<ReturnType<typeof analysisFindingBucket>, number> = {
    bug: 0,
    passed: 1,
    coverage: 2,
};

/**
 * Investigator-owned finding persistence: file one test's finding onto the run's `AnalysisFinding` store when its
 * self-heal loop terminates. Idempotent - a re-run (or a parent-authored containment finding overwriting a child
 * that crashed after persisting) upserts on the `(report, findingKey)` unique, so the row set always mirrors the
 * latest classification. The `findingKey` is the test's slug: an Investigator owns exactly one finding per slug.
 *
 * This replaces the Reconciler's single cross-test write - there is no dedup/merge anymore, so each finding is one
 * test's verdict carrying its own rich evidence. The Reporter later reconciles these into branch-scoped issues.
 */
export async function persistAnalysisFinding(
    input: PersistAnalysisFindingInput,
): Promise<PersistAnalysisFindingOutput> {
    const { snapshotId, finding } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only the non-canonical
    // slug/category go in `extra`.
    const logger = rootLogger.child({
        name: "persistAnalysisFinding",
        extra: { slug: finding.slug, category: finding.category },
    });
    logger.info("Persisting analysis finding");

    // BranchSnapshot inherits its org from its branch; the finding's denormalized org backs the cross-report index.
    const snapshot = await db.branchSnapshot.findUnique({
        where: { id: snapshotId },
        select: { branch: { select: { organizationId: true } } },
    });
    if (snapshot == null) throw new Error(`Snapshot ${snapshotId} not found; cannot persist the finding`);
    const organizationId = snapshot.branch.organizationId;

    const fields = buildFindingFields(finding);
    await db.analysisFinding.upsert({
        where: { reportSnapshotId_findingKey: { reportSnapshotId: snapshotId, findingKey: finding.slug } },
        create: {
            reportSnapshotId: snapshotId,
            organizationId,
            findingKey: finding.slug,
            slug: finding.slug,
            ...fields,
        },
        update: fields,
    });

    logger.info("Persisted analysis finding");
    return { findingKey: finding.slug };
}

/**
 * The finding's columns, shared by the upsert's `create` and `update` so a re-file overwrites every field. The
 * rich evidence rides from the classifier's `report`; `selectionReason`/`selfHealNote` are the Investigator's own
 * per-test context; `displayOrder` is derived from the finding's presentation bucket.
 */
function buildFindingFields(finding: AnalysisCandidateFinding) {
    const report = finding.report;
    return {
        category: finding.category,
        headline: finding.headline,
        planEdited: finding.planEdited,
        origin: finding.origin,
        selectionReason: finding.selectionReason,
        selfHealNote: finding.selfHealNote,
        displayOrder: BUCKET_DISPLAY_ORDER[analysisFindingBucket(finding.category)],
        confidence: report?.confidence,
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
    };
}
