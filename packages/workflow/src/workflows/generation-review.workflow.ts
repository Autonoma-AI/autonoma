import { proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities";
import { TaskQueue } from "../task-queues";

const diffs = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface GenerationReviewInput {
    generationId: string;
}

export async function generationReviewWorkflow(input: GenerationReviewInput): Promise<void> {
    await diffs.reviewGeneration({ generationId: input.generationId });
}
