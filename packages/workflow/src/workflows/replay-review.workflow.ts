import { proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities";
import { TaskQueue } from "../task-queues";

const diffs = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface ReplayReviewInput {
    runId: string;
}

export async function replayReviewWorkflow(input: ReplayReviewInput): Promise<void> {
    await diffs.reviewReplay({ runId: input.runId });
}
