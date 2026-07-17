import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater, UpdateTest } from "@autonoma/test-updates";
import type { SelfHealAnalysisTestInput, SelfHealAnalysisTestOutput } from "@autonoma/workflow/activities";

/**
 * Self-heal for the `test_is_wrong` route: the classifier said the app rendered correctly but the TEST is stale,
 * and produced a complete revised plan. The Investigator authors that plan onto its OWN test via the canonical
 * `UpdateTest` update action on the detached snapshot (mirroring how Impact Analysis uses `AddTest` /
 * `RegenerateSteps`): `UpdateTest.updatePlan` edits this test case's plan in place (slug preserved) and queues one
 * generation. Row-local by construction - it only touches this `(snapshot, testCase)`'s assignment/plan, so every
 * OTHER test on the twin (and concurrent Investigators editing their own tests) is untouched.
 *
 * The test's current scenario is preserved: the new plan pins the same scenario the run used, so the re-run
 * provisions the same data. Returns `skippedReason` (fall through to `delete`) when the slug has no assignment on
 * the snapshot - an un-fixable test we cannot rewrite.
 */
export async function selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput> {
    const { snapshotId, slug, plan } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "selfHealAnalysisTest", extra: { slug } });
    logger.info("Authoring a self-heal plan rewrite on the test's own rows");

    const target = await resolveTarget(snapshotId, slug, logger);
    if (target == null) {
        return { skippedReason: "no assignment for this slug on the snapshot" };
    }

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId,
        organizationId: target.organizationId,
    });
    const { generationId } = await updater.apply(
        new UpdateTest({ testCaseId: target.testCaseId, plan, scenarioId: target.scenarioId }),
    );
    logger.info("Self-heal plan authored; queued a fresh generation to re-run", {
        extra: { testCaseId: target.testCaseId, generationId, scenarioId: target.scenarioId },
    });
    return { testGenerationId: generationId, scenarioId: target.scenarioId };
}

interface SelfHealTarget {
    testCaseId: string;
    /** The scenario the current plan pins (preserved onto the rewritten plan), when it pins one. */
    scenarioId?: string;
    organizationId: string;
}

/**
 * Resolve the test's own `(snapshot, testCase)` rows from its slug: the test case id (what `UpdateTest` edits), the
 * scenario its current plan pins (preserved), and the owning organization (verified by the updater). Returns
 * undefined when the slug has no assignment on the snapshot.
 */
async function resolveTarget(snapshotId: string, slug: string, logger: Logger): Promise<SelfHealTarget | undefined> {
    const assignment = await db.testCaseAssignment.findFirst({
        where: { snapshotId, testCase: { slug } },
        select: {
            testCaseId: true,
            plan: { select: { scenarioId: true } },
            testCase: { select: { organizationId: true } },
        },
    });
    if (assignment == null) {
        logger.warn("No assignment for this slug on the snapshot; cannot self-heal", { extra: { slug } });
        return undefined;
    }
    return {
        testCaseId: assignment.testCaseId,
        scenarioId: assignment.plan?.scenarioId ?? undefined,
        organizationId: assignment.testCase.organizationId,
    };
}
