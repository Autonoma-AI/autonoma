import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export async function triggerReplayReviewWorkflow(runId: string): Promise<void> {
    logger.info("Triggering replay review workflow", { runId });

    const client = await getTemporalClient();
    const workflowId = `replay-review-${runId}`;

    await client.workflow.start(WORKFLOW_TYPE.REPLAY_REVIEW, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
        taskQueue: TaskQueue.GENERAL,
        args: [{ runId }],
    });

    logger.info("Replay review workflow started", { workflowId, runId });
}
