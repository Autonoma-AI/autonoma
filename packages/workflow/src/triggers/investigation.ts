import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerInvestigationJobParams {
    snapshotId: string;
}

/**
 * Start the shadow investigation workflow for a snapshot. Runs in PARALLEL with the diffs job; the workflow
 * id is idempotent (`investigation-<snapshotId>`) so a duplicate trigger is rejected rather than re-run.
 */
export async function triggerInvestigationJob(params: TriggerInvestigationJobParams): Promise<void> {
    const { snapshotId } = params;

    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        logger.info("Triggering investigation workflow");

        const client = await getTemporalClient();
        const workflowId = `investigation-${snapshotId}`;

        await client.workflow.start(WORKFLOW_TYPE.INVESTIGATION, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.INVESTIGATION,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [{ snapshotId }],
        });

        logger.info("Investigation workflow started", { workflowId });
    });
}

/**
 * Cancel the running investigation workflow for the given investigation snapshot. Called when a newer push
 * supersedes the head this investigation was launched for, so we stop running shadow tests against a preview
 * that is about to be replaced. Best-effort: a missing/already-finished workflow is logged, not thrown.
 */
export async function cancelInvestigationJob(snapshotId: string): Promise<void> {
    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        const workflowId = `investigation-${snapshotId}`;
        logger.info("Cancelling investigation workflow for snapshot", { workflowId });

        try {
            const client = await getTemporalClient();
            const handle = client.workflow.getHandle(workflowId);

            try {
                await handle.describe();
                await handle.cancel();
                logger.info("Investigation workflow cancelled successfully", { workflowId });
            } catch (error) {
                logger.info("Investigation workflow not found or already completed", {
                    workflowId,
                    extra: { error: String(error) },
                });
            }
        } catch (error) {
            logger.error("Failed to cancel investigation workflow", error, { workflowId });
            throw error;
        }
    });
}
