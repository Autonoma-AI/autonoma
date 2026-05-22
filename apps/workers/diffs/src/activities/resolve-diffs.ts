import { db } from "@autonoma/db";
import { runDiffsResolution } from "@autonoma/job-diffs/run-resolution";
import { logger as rootLogger } from "@autonoma/logger";
import type { ResolveDiffsInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function resolveDiffs({ snapshotId }: ResolveDiffsInput): Promise<void> {
    const logger = rootLogger.child({ name: "resolveDiffs" });
    logger.info("Starting diffs resolution");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "resolving" },
        });

        await runDiffsResolution(snapshotId);
    } catch (error) {
        await db.diffsJob.update({
            where: { snapshotId },
            data: {
                status: "failed",
                failureReason: error instanceof Error ? error.message : String(error),
                completedAt: new Date(),
            },
        });
        throw error;
    } finally {
        clearInterval(heartbeat);
    }
}
