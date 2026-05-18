import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities } from "../activities";
import { TaskQueue } from "../task-queues";
import type { TestPlanItem, WorkflowArchitecture } from "../types";
import { singleGenerationWorkflow } from "./single-generation.workflow";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

export interface BatchGenerationInput {
    snapshotId: string;
    testPlans: TestPlanItem[];
    architecture: WorkflowArchitecture;
}

export async function batchGenerationWorkflow(input: BatchGenerationInput): Promise<void> {
    const { snapshotId, testPlans, architecture } = input;

    const results = await Promise.allSettled(
        testPlans.map((plan) =>
            executeChild(singleGenerationWorkflow, {
                workflowId: `generation-${plan.testGenerationId}`,
                args: [
                    {
                        testGenerationId: plan.testGenerationId,
                        scenarioId: plan.scenarioId,
                        architecture,
                    },
                ],
            }),
        ),
    );

    for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
            log.warn("Child generation workflow failed", {
                testGenerationId: testPlans[index]!.testGenerationId,
                reason: String(result.reason),
            });
        }
    }

    await general.assignGenerationResults({
        snapshotId,
        generationIds: testPlans.map((p) => p.testGenerationId),
    });
}
