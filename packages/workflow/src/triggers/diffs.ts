import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import type { WorkflowRef } from "../types";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerDiffsJobParams {
    branchId: string;
    snapshotId: string;
}

export async function triggerDiffsJob(params: TriggerDiffsJobParams): Promise<void> {
    const { branchId, snapshotId } = params;

    return await withObservabilityContext({ branch: { branchId }, snapshot: { snapshotId } }, async () => {
        logger.info("Triggering diffs analysis workflow");

        const client = await getTemporalClient();
        const workflowId = `diffs-analysis-${snapshotId}`;

        await client.workflow.start(WORKFLOW_TYPE.DIFFS_ANALYSIS, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.DIFFS,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [{ snapshotId }],
        });

        logger.info("Diffs analysis workflow started", { workflowId });
    });
}

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
