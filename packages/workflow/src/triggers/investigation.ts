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
