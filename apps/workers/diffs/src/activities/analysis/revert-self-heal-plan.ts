import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteStore } from "@autonoma/test-suite";
import type { RevertSelfHealPlanInput, RevertSelfHealPlanOutput } from "@autonoma/workflow/activities";
import { resolveAnalysisTestTarget } from "./resolve-analysis-test";

/**
 * Put a test's pre-self-heal plan back when the Investigator KEEPS a `plan_mismatch`. `selfHealAnalysisTest` applied
 * the classifier's rewrite and the re-run still failed on a healthy app, so the test is kept rather than removed -
 * and the rewrite must NOT be promoted: it is a plan we know is broken, and a rewrite optimized to make the test pass
 * can blunt the very assertion catching a real defect.
 *
 * The restore repoints the assignment at the pre-rewrite plan record (`OpenSnapshot.restorePlan`) rather than
 * re-authoring its text, so the snapshot ends up genuinely unchanged for this test - the `planId`-keyed change
 * computations would otherwise report it as modified with identical before/after plans. No re-run is started (the
 * loop is over), and the restored plan pins its own scenario. Row-local by construction. Returns `reverted: false`
 * when the slug has no assignment.
 */
export async function revertSelfHealPlan(input: RevertSelfHealPlanInput): Promise<RevertSelfHealPlanOutput> {
    const { snapshotId, slug, planId } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "revertSelfHealPlan", extra: { slug, planId } });
    logger.info("Restoring the test's pre-self-heal plan");

    const target = await resolveAnalysisTestTarget(snapshotId, slug);
    if (target == null) {
        logger.warn("Cannot revert a test with no assignment on the snapshot");
        return { reverted: false, reason: "no assignment for this slug on the snapshot" };
    }

    const store = new TestSuiteStore(db);
    const snapshot = await store.reopen(snapshotId, { organizationId: target.organizationId });
    await snapshot.restorePlan({ testCaseId: target.testCaseId, planId });
    logger.info("Restored the pre-self-heal plan; no re-run started", { extra: { testCaseId: target.testCaseId } });
    return { reverted: true };
}
