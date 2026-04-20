import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerDiffsJobParams {
    branchId: string;
    snapshotId: string;
}

export async function triggerDiffsJob(params: TriggerDiffsJobParams): Promise<void> {
    const { branchId, snapshotId } = params;

    logger.info("Triggering diffs analysis workflow", { branchId, snapshotId });

    const client = await getTemporalClient();
    const workflowId = `diffs-analysis-${snapshotId}`;

    await client.workflow.start(WORKFLOW_TYPE.DIFFS_ANALYSIS, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        taskQueue: TaskQueue.GENERAL,
        searchAttributes: getWorkflowSearchAttributes(),
        args: [{ snapshotId }],
    });

    logger.info("Diffs analysis workflow started", { workflowId, branchId, snapshotId });
}

/**
 * Cancel the running diffs analysis workflow for the given snapshot.
 * Called when a new trigger arrives while an older snapshot is still being analyzed.
 */
export async function cancelDiffsJob(snapshotId: string): Promise<void> {
    const workflowId = `diffs-analysis-${snapshotId}`;
    logger.info("Cancelling diffs workflow for snapshot", { snapshotId, workflowId });

    try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(workflowId);

        try {
            await handle.describe();
            await handle.cancel();
            logger.info("Diffs workflow cancelled successfully", { snapshotId, workflowId });
        } catch {
            logger.info("Diffs workflow not found or already completed", { snapshotId, workflowId });
        }
    } catch (error) {
        logger.error("Failed to cancel diffs workflow", { snapshotId, workflowId, error });
        throw error;
    }
}
