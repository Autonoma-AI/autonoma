import { logger, withObservabilityContext } from "@autonoma/logger";
import { getTemporalClient } from "../client";
import type { WorkflowRef } from "../types";

/**
 * Nothing starts a diffs workflow any more - a PR run is always an analysis run. What remains here serves the
 * runs that already exist: the read path behind a snapshot's Temporal link, and the cancel used when a push
 * supersedes a pending snapshot created before the cutover.
 */
export async function findLatestWorkflowBySnapshotId(snapshotId: string): Promise<WorkflowRef | undefined> {
    const client = await getTemporalClient();
    const handle = client.workflow.getHandle(`diffs-analysis-${snapshotId}`);

    try {
        const description = await handle.describe();
        return {
            workflowId: description.workflowId,
            runId: description.runId,
        };
    } catch (error) {
        logger.warn("Failed to query diffs workflow", {
            snapshot: { snapshotId },
            extra: { error: String(error) },
        });
        return undefined;
    }
}

/**
 * Cancel the running diffs analysis workflow for the given snapshot.
 * Called when a new trigger arrives while an older snapshot is still being analyzed.
 */
export async function cancelDiffsJob(snapshotId: string): Promise<void> {
    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        const workflowId = `diffs-analysis-${snapshotId}`;
        logger.info("Cancelling diffs workflow for snapshot", { workflowId });

        try {
            const client = await getTemporalClient();
            const handle = client.workflow.getHandle(workflowId);

            try {
                await handle.describe();
                await handle.cancel();
                logger.info("Diffs workflow cancelled successfully", { workflowId });
            } catch {
                logger.info("Diffs workflow not found or already completed", { workflowId });
            }
        } catch (error) {
            logger.error("Failed to cancel diffs workflow", error, { workflowId });
            throw error;
        }
    });
}
