import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater, UpdateTest } from "@autonoma/test-updates";
import type { SelfHealAnalysisTestInput, SelfHealAnalysisTestOutput } from "@autonoma/workflow/activities";
import { resolveAnalysisTestTarget } from "./resolve-analysis-test";

/**
 * Self-heal for the `test_is_wrong` route: the classifier said the app rendered correctly but the TEST's plan does not
 * match it, and produced a complete revised plan. The Investigator authors that plan onto its OWN test via the
 * canonical `UpdateTest` update action (mirroring how Impact Analysis uses `AddTest` / `RegenerateSteps`):
 * `UpdateTest.updatePlan` mints a plan for this test case and repoints its assignment (slug preserved), then queues one
 * generation. Row-local by construction - it only touches this `(snapshot, testCase)`'s assignment/plan, so every
 * OTHER test on the snapshot (and concurrent Investigators editing their own tests) is untouched.
 *
 * The test's current scenario is preserved: the new plan pins the same scenario the run used, so the re-run provisions
 * the same data. It also returns `previousPlanId` - the plan the assignment held BEFORE the rewrite - which is what a
 * kept `plan_mismatch` restores so a rewrite that still fails is never promoted.
 *
 * A rewrite is only applied when it can be UNDONE, so it refuses (`prepared: false`) when the slug has no assignment
 * or that assignment pins no plan. Both leave the snapshot untouched for the caller to settle as a kept
 * `plan_mismatch`.
 */
export async function selfHealAnalysisTest(input: SelfHealAnalysisTestInput): Promise<SelfHealAnalysisTestOutput> {
    const { snapshotId, slug, plan } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "selfHealAnalysisTest", extra: { slug } });
    logger.info("Authoring a self-heal plan rewrite on the test's own rows");

    const target = await resolveAnalysisTestTarget(snapshotId, slug);
    if (target == null) {
        logger.warn("Cannot self-heal a test with no assignment on the snapshot");
        return { prepared: false, skippedReason: "no assignment for this slug on the snapshot" };
    }
    // Checked BEFORE the rewrite, because it is the rewrite's exit route: with no plan pinned there is nothing to
    // restore, so a rewrite that then failed would be stuck on the snapshot and promote. Refusing here leaves the test
    // to settle as a kept `plan_mismatch` on the plan it already had.
    if (target.planId == null) {
        logger.warn("Cannot self-heal a test whose assignment pins no plan; a rewrite could not be reverted", {
            extra: { testCaseId: target.testCaseId },
        });
        return { prepared: false, skippedReason: "the assignment pins no plan, so a rewrite could not be reverted" };
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
        extra: {
            testCaseId: target.testCaseId,
            generationId,
            scenarioId: target.scenarioId,
            previousPlanId: target.planId,
        },
    });
    return {
        prepared: true,
        testGenerationId: generationId,
        previousPlanId: target.planId,
        scenarioId: target.scenarioId,
    };
}
