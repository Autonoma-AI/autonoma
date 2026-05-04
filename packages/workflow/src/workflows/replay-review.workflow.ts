import { proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities } from "../activities";
import { TaskQueue } from "../task-queues";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

export interface ReplayReviewInput {
    runId: string;
}

export async function replayReviewWorkflow(input: ReplayReviewInput): Promise<void> {
    await general.reviewReplay({ runId: input.runId });
}
