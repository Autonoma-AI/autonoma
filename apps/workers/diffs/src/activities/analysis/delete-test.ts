import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { RemoveTest, TestSuiteUpdater } from "@autonoma/test-updates";
import type { DeleteAnalysisTestInput, DeleteAnalysisTestOutput } from "@autonoma/workflow/activities";
import { resolveAnalysisTestTarget } from "./resolve-analysis-test";

/**
 * Removal for the `invalid_test` verdict: the Investigator resolved that its test is IRREPARABLY broken (a feature
 * that never existed, structurally unexecutable steps, a premise the app contradicts), so it removes its OWN test
 * from the twin via the canonical `RemoveTest` update action - this snapshot's assignment, and nothing else.
 *
 * That holds for a test proposed this run as much as for a pre-existing one. The tests tree reads the active
 * snapshot's assignments, so an unassigned test case is already invisible; destroying the `TestCase` instead would
 * cascade away its plans, generations and classifications - the record of WHY the test was removed - and it is
 * already persisted by the time this runs.
 *
 * Row-local by construction (nothing outside this test), and it never promotes the snapshot. Idempotent: a slug with
 * no assignment on the snapshot is a no-op that reports `deleted: false`. The `invalid_test` verdict is reported by
 * the workflow regardless of whether a row was actually removed.
 */
export async function deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput> {
    const { snapshotId, slug } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "deleteAnalysisTest", extra: { slug } });
    logger.info("Removing an invalid test from the twin");

    const target = await resolveAnalysisTestTarget(snapshotId, slug);
    if (target == null) {
        logger.warn("Cannot remove a test with no assignment on the snapshot");
        return { deleted: false, reason: "no assignment for this slug on the snapshot" };
    }

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId,
        organizationId: target.organizationId,
    });
    await updater.apply(new RemoveTest({ testCaseId: target.testCaseId }));

    logger.info("Removed the test's assignment from the twin", { extra: { testCaseId: target.testCaseId } });
    return { deleted: true };
}
