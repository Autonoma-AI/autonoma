import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { RemoveTest, TestSuiteUpdater } from "@autonoma/test-updates";
import type { DeleteAnalysisTestInput, DeleteAnalysisTestOutput } from "@autonoma/workflow/activities";

/**
 * Eager self-delete for the `delete` terminal: the Investigator resolved that its test is a correct-app test it
 * could not stabilize, so it removes its OWN test from the twin. The scope depends on the test's `origin`:
 *
 * - `pre_existing` (affected): its global `TestCase` is a real suite member, so remove ONLY this snapshot's
 *   assignment via the canonical `RemoveTest` update action - the TestCase and every other snapshot are untouched.
 * - `proposed`: it was authored THIS run by Impact Analysis (`AddTest`) and its only rows live on this detached
 *   snapshot, so remove the whole `TestCase` (cascading its plans + generations + assignment). Removing only the
 *   assignment would orphan a real (non-shadow) catalog row, which the user-facing suite read (`shadow: false`,
 *   not snapshot-scoped) would then surface - a leak that accumulates every time a proposed test cannot be
 *   established.
 *
 * Row-local by construction (nothing outside this test), and it never promotes the snapshot. Idempotent: a slug
 * with no assignment on the snapshot is a no-op that reports `deleted: false`. The `delete` verdict is reported by
 * the workflow regardless of whether a row was actually removed.
 */
export async function deleteAnalysisTest(input: DeleteAnalysisTestInput): Promise<DeleteAnalysisTestOutput> {
    const { snapshotId, slug, origin } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "deleteAnalysisTest", extra: { slug, origin } });
    logger.info("Self-deleting the test from the twin");

    const assignment = await db.testCaseAssignment.findFirst({
        where: { snapshotId, testCase: { slug } },
        select: { testCaseId: true, testCase: { select: { organizationId: true } } },
    });
    if (assignment == null) {
        logger.info("No assignment for this slug on the snapshot; nothing to delete");
        return { deleted: false, reason: "no assignment for this slug on the snapshot" };
    }

    if (origin === "proposed") {
        // Cascades the assignment + plans + generations (a proposed test has no bug/affected-test references).
        await db.testCase.delete({ where: { id: assignment.testCaseId } });
        logger.info("Removed the proposed test case entirely from the twin", {
            extra: { testCaseId: assignment.testCaseId },
        });
        return { deleted: true };
    }

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId,
        organizationId: assignment.testCase.organizationId,
    });
    await updater.apply(new RemoveTest({ testCaseId: assignment.testCaseId }));

    logger.info("Removed the pre-existing test's assignment from the twin", {
        extra: { testCaseId: assignment.testCaseId },
    });
    return { deleted: true };
}
