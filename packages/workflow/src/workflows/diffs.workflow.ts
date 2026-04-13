import { proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities } from "../activities";
import { TaskQueue } from "../task-queues";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 2 },
    taskQueue: TaskQueue.GENERAL,
});

export interface DiffsAnalysisInput {
    branchId: string;
}

export async function diffsAnalysisWorkflow(input: DiffsAnalysisInput): Promise<void> {
    await general.analyzeDiffs({ branchId: input.branchId });
}
