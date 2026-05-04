import { proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities } from "../activities";
import { TaskQueue } from "../task-queues";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

export interface GenerationReviewInput {
    generationId: string;
}

export async function generationReviewWorkflow(input: GenerationReviewInput): Promise<void> {
    await general.reviewGeneration({ generationId: input.generationId });
}
