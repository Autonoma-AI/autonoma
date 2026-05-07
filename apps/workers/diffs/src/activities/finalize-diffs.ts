import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type { FinalizeDiffsInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function finalizeDiffs({ snapshotId }: FinalizeDiffsInput): Promise<void> {
    const logger = rootLogger.child({ name: "finalizeDiffs", snapshotId });
    logger.info("Starting diffs finalization");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "finalizing" },
        });

        const updater = await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId });

        const generations = await db.testGeneration.findMany({
            where: { snapshotId },
            select: { id: true },
        });
        const generationIds = generations.map((g) => g.id);

        if (generationIds.length > 0) {
            const { assigned, failed } = await updater.assignGenerationResults(generationIds);
            logger.info("Generation results assigned", { assigned, failed });
        }

        await updater.finalize();
        logger.info("Snapshot finalized and activated");

        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "completed", completedAt: new Date() },
        });
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
