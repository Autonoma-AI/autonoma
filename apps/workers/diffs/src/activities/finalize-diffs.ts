import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { FinalizeDiffsInput } from "@autonoma/workflow/activities";

/**
 * Marks the DiffsJob in its terminal state. Called after the refinement loop
 * has run: on success the caller invokes without `failureReason` (status =
 * "completed"); on failure the caller passes the error message and the job is
 * marked failed with that reason.
 */
export async function finalizeDiffs({ snapshotId, failureReason }: FinalizeDiffsInput): Promise<void> {
    const logger = rootLogger.child({ name: "finalizeDiffs" });
    const completedAt = new Date();

    if (failureReason != null) {
        logger.info("Marking diffs job failed", { extra: { failureReason } });
        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "failed", failureReason, completedAt },
        });
        return;
    }

    logger.info("Marking diffs job completed");
    await db.diffsJob.update({
        where: { snapshotId },
        data: { status: "completed", completedAt },
    });
}
