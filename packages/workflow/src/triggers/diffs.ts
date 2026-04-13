import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerDiffsJobParams {
    branchId: string;
}

export async function triggerDiffsJob(params: TriggerDiffsJobParams): Promise<void> {
    const { branchId } = params;

    logger.info("Triggering diffs analysis workflow", { branchId });

    const client = await getTemporalClient();
    const workflowId = `diffs-analysis-${branchId}`;

    await client.workflow.start(WORKFLOW_TYPE.DIFFS_ANALYSIS, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        taskQueue: TaskQueue.GENERAL,
        args: [{ branchId }],
    });

    logger.info("Diffs analysis workflow started", { workflowId, branchId });
}

/**
 * Cancel any running diffs analysis workflow for the given branch.
 * This is called when a new PR is received while a previous one is still analyzing.
 */
export async function cancelDiffsJob(branchId: string): Promise<void> {
    const workflowId = `diffs-analysis-${branchId}`;
    logger.info("Cancelling diffs workflow for branch", { branchId, workflowId });

    try {
        const client = await getTemporalClient();
        const handle = client.workflow.getHandle(workflowId);

        // Check if the workflow exists before attempting to cancel
        try {
            await handle.describe();
            await handle.cancel();
            logger.info("Diffs workflow cancelled successfully", { branchId, workflowId });
        } catch {
            // Workflow doesn't exist or is already completed - this is fine
            logger.info("Diffs workflow not found or already completed", { branchId, workflowId });
        }
    } catch (error) {
        logger.error("Failed to cancel diffs workflow", { branchId, workflowId, error });
        throw error;
    }
}
