import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type { FinalizeDiffsInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function finalizeDiffs(input: FinalizeDiffsInput): Promise<void> {
    const logger = rootLogger.child({ name: "finalizeDiffs", branchId: input.branchId });
    logger.info("Starting diffs finalization", { generationIds: input.generationIds });

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        const { branchId, generationIds } = input;
        const updater = await TestSuiteUpdater.continueUpdate({ db, branchId });

        if (generationIds.length > 0) {
            const { assigned, failed } = await updater.assignGenerationResults(generationIds);
            logger.info("Generation results assigned", { assigned, failed });
        }

        await updater.finalize();
        logger.info("Snapshot finalized and activated");
    } finally {
        clearInterval(heartbeat);
    }
}
