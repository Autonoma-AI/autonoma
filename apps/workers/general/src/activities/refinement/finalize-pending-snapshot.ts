import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type { FinalizePendingSnapshotInput } from "@autonoma/workflow/activities";

/**
 * Promotes a still-processing snapshot to active. Called after the refinement
 * loop completes; the snapshot must stay in "processing" status throughout
 * the loop for the apply* activities to operate against it.
 */
export async function finalizePendingSnapshot(input: FinalizePendingSnapshotInput): Promise<void> {
    const logger = rootLogger.child({ name: "finalizePendingSnapshot" });
    logger.info("Finalizing snapshot");

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
    });
    await updater.finalize();
    logger.info("Snapshot finalized");
}
