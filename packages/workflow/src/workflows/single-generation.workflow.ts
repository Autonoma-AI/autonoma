import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities, GeneralActivities, MobileActivities, WebActivities } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture } from "../types";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

const diffs = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "15m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface SingleGenerationInput {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
    urlOverride?: string;
    sdkUrlOverride?: string;
}

export async function singleGenerationWorkflow(input: SingleGenerationInput): Promise<void> {
    const { testGenerationId, scenarioId, architecture, urlOverride, sdkUrlOverride } = input;

    let scenarioInstanceId: string | undefined;

    if (scenarioId != null) {
        log.info("Starting scenario setup", { testGenerationId, scenarioId });
        try {
            const scenarioUpResult = await general.scenarioUp({
                entityId: testGenerationId,
                scenarioId,
                sdkUrlOverride,
            });
            scenarioInstanceId = scenarioUpResult.scenarioInstanceId;
            log.info("Scenario setup complete", { testGenerationId, scenarioInstanceId });
        } catch (error) {
            const message = rootFailureMessage(error);
            log.error("Scenario setup failed", { testGenerationId, scenarioId, message });
            await CancellationScope.nonCancellable(() =>
                general.markGenerationFailed({
                    testGenerationId,
                    failure: { kind: "scenario_setup", message },
                }),
            );
            throw error;
        }
    } else {
        log.warn("Scenario setup skipped: test plan has no linked scenario", { testGenerationId });
    }

    try {
        await runExecution(architecture, testGenerationId, urlOverride, sdkUrlOverride);
    } catch (error) {
        const message = rootFailureMessage(error);
        log.error("Generation execution failed, marking as failed", { testGenerationId, message });
        await CancellationScope.nonCancellable(() =>
            general.markGenerationFailed({ testGenerationId, failure: { kind: "engine_error", message } }),
        );
        throw error;
    } finally {
        const cancelled = CancellationScope.current().consideredCancelled;
        await CancellationScope.nonCancellable(async () => {
            const postSteps: Promise<unknown>[] = [general.notifyGenerationExit({ testGenerationId })];

            if (!cancelled) {
                postSteps.push(diffs.reviewGeneration({ generationId: testGenerationId }));
            }

            if (scenarioInstanceId != null) {
                postSteps.push(general.scenarioDown({ scenarioInstanceId }));
            }

            await Promise.allSettled(postSteps);
        });
    }
}

async function runExecution(
    architecture: WorkflowArchitecture,
    testGenerationId: string,
    urlOverride?: string,
    sdkUrlOverride?: string,
): Promise<void> {
    if (architecture === "WEB") {
        const { runWebGeneration } = proxyActivities<WebActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.WEB,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runWebGeneration({ testGenerationId, urlOverride, sdkUrlOverride });
    } else {
        const { runMobileGeneration } = proxyActivities<MobileActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.MOBILE,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runMobileGeneration({ testGenerationId });
    }
}
