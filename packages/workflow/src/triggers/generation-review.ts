import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export async function triggerGenerationReviewWorkflow(generationId: string): Promise<void> {
    logger.info("Triggering generation review workflow", { generationId });

    const client = await getTemporalClient();
    const workflowId = `generation-review-${generationId}`;

    await client.workflow.start(WORKFLOW_TYPE.GENERATION_REVIEW, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        taskQueue: TaskQueue.GENERAL,
        args: [{ generationId }],
    });

    logger.info("Generation review workflow started", { workflowId, generationId });
}
