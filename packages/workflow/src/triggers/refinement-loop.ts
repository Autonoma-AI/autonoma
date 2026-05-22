import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerRefinementLoopParams {
    snapshotId: string;
    triggeredBy: "onboarding" | "diffs";
    maxIterations?: number;
}

export async function triggerRefinementLoop(params: TriggerRefinementLoopParams): Promise<void> {
    const { snapshotId, triggeredBy, maxIterations } = params;

    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        logger.info("Triggering refinement loop workflow");

        const client = await getTemporalClient();
        const workflowId = `refinement-loop-${snapshotId}`;

        await client.workflow.start(WORKFLOW_TYPE.REFINEMENT_LOOP, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.GENERAL,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [{ snapshotId, triggeredBy, maxIterations }],
        });

        logger.info("Refinement loop workflow started", { workflowId });
    });
}
