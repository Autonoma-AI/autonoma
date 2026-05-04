import { executeChild, proxyActivities } from "@temporalio/workflow";
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
    testPlans: TestPlanItem[];
    architecture: WorkflowArchitecture;
    autoActivate: boolean;
}

export async function batchGenerationWorkflow(input: BatchGenerationInput): Promise<void> {
    const { testPlans, architecture, autoActivate } = input;

    // Run all test generations in parallel - each as a child workflow
    await Promise.all(
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

    // After all generations complete (regardless of success), assign results
    await general.assignGenerationResults({
        generationIds: testPlans.map((p) => p.testGenerationId),
        autoActivate,
    });
}
