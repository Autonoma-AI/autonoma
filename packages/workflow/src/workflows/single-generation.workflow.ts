import { log, proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities, MobileActivities, WebActivities } from "../activities";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture } from "../types";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.GENERAL,
});

export interface SingleGenerationInput {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
    skipIssueBugCreation?: boolean;
}

export async function singleGenerationWorkflow(input: SingleGenerationInput): Promise<void> {
    const { testGenerationId, scenarioId, architecture } = input;

    let scenarioInstanceId: string | undefined;

    if (scenarioId != null) {
        log.info("Starting scenario setup", { testGenerationId, scenarioId });
        try {
            const scenarioUpResult = await general.scenarioUp({
                scenarioJobType: "generation",
                entityId: testGenerationId,
                scenarioId,
            });
            scenarioInstanceId = scenarioUpResult.scenarioInstanceId;
            log.info("Scenario setup complete", { testGenerationId, scenarioInstanceId });
        } catch (error) {
            const reason = error instanceof Error ? error.message : "Scenario setup failed";
            log.error("Scenario setup failed", { testGenerationId, scenarioId, reason });
            await general.markGenerationFailed({
                testGenerationId,
                reason: `Scenario setup failed: ${reason}`,
            });
            throw error;
        }
    } else {
        log.warn("Scenario setup skipped: test plan has no linked scenario", { testGenerationId });
    }

    try {
        await runExecution(architecture, testGenerationId);
    } finally {
        const postSteps: Promise<void>[] = [
            general.notifyGenerationExit({ testGenerationId }),
            general.reviewGeneration({
                generationId: testGenerationId,
                skipIssueBugCreation: input.skipIssueBugCreation,
            }),
        ];

        if (scenarioInstanceId != null) {
            postSteps.push(general.scenarioDown({ scenarioInstanceId }));
        }

        await Promise.allSettled(postSteps);
    }
}

async function runExecution(architecture: WorkflowArchitecture, testGenerationId: string): Promise<void> {
    if (architecture === "WEB") {
        const { runWebGeneration } = proxyActivities<WebActivities>({
            startToCloseTimeout: "30m",
            taskQueue: TaskQueue.WEB,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runWebGeneration({ testGenerationId });
    } else {
        const { runMobileGeneration } = proxyActivities<MobileActivities>({
            startToCloseTimeout: "30m",
            taskQueue: TaskQueue.MOBILE,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runMobileGeneration({ testGenerationId });
    }
}
