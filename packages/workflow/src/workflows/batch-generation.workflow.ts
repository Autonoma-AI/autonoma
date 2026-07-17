import { executeChild, log, ParentClosePolicy } from "@temporalio/workflow";
import type { TestPlanItem, WorkflowArchitecture } from "../types";
import { singleGenerationWorkflow } from "./single-generation.workflow";

export interface BatchGenerationInput {
    testPlans: TestPlanItem[];
    architecture: WorkflowArchitecture;
}

export async function batchGenerationWorkflow(input: BatchGenerationInput): Promise<void> {
    const { testPlans, architecture } = input;

    const results = await Promise.allSettled(
        testPlans.map((plan) =>
            executeChild(singleGenerationWorkflow, {
                workflowId: `generation-${plan.testGenerationId}`,
                parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
                args: [
                    {
                        testGenerationId: plan.testGenerationId,
                        scenarioId: plan.scenarioId,
                        architecture,
                        urlOverride: plan.urlOverride,
                        sdkUrlOverride: plan.sdkUrlOverride,
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
}
