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

export interface RunReplayInput {
    runId: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
    urlOverride?: string;
    sdkUrlOverride?: string;
}

export async function runReplayWorkflow(input: RunReplayInput): Promise<void> {
    const { runId, architecture, scenarioId, urlOverride, sdkUrlOverride } = input;

    let scenarioInstanceId: string | undefined;

    // Steps 1-2 are wrapped in a single try/finally so that scenarioDown always
    // runs even if scenarioUp itself fails mid-way
    try {
        // Step 1: Scenario up (if needed)
        if (scenarioId != null) {
            log.info("Starting scenario setup", { runId, scenarioId });
            try {
                const result = await general.scenarioUp({
                    scenarioJobType: "run",
                    entityId: runId,
                    scenarioId,
                    sdkUrlOverride,
                });
                scenarioInstanceId = result.scenarioInstanceId;
                log.info("Scenario setup complete", { runId, scenarioInstanceId });
            } catch (error) {
                const message = rootFailureMessage(error);
                log.error("Scenario setup failed", { runId, scenarioId, message });
                await CancellationScope.nonCancellable(() =>
                    general.markRunFailed({ runId, failure: { kind: "scenario_setup", message } }),
                );
                throw error;
            }
        } else {
            log.warn("Scenario setup skipped: run has no linked scenario", { runId });
        }

        // Step 2: Run the replay execution agent
        try {
            await runReplayExecution(architecture, runId, urlOverride);
        } catch (error) {
            const message = rootFailureMessage(error);
            log.error("Run replay failed, marking as failed", { runId, message });
            await CancellationScope.nonCancellable(() =>
                general.markRunFailed({ runId, failure: { kind: "engine_error", message } }),
            );
            throw error;
        }
    } finally {
        // Step 3: After replay completes (or fails), run cleanup in parallel.
        // Use allSettled so that a failure in one step does not prevent the others
        // from executing - e.g. a scenarioDown failure must not skip reviewReplay.
        const cancelled = CancellationScope.current().consideredCancelled;
        await CancellationScope.nonCancellable(async () => {
            const postSteps: Promise<unknown>[] = [];

            if (!cancelled) {
                postSteps.push(diffs.reviewReplay({ runId }));
            }

            if (scenarioInstanceId != null) {
                postSteps.push(general.scenarioDown({ scenarioInstanceId }));
            }

            await Promise.allSettled(postSteps);
        });
    }
}

async function runReplayExecution(
    architecture: WorkflowArchitecture,
    runId: string,
    urlOverride?: string,
): Promise<void> {
    if (architecture === "WEB") {
        const { runWebReplay } = proxyActivities<WebActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.WEB,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runWebReplay({ runId, urlOverride });
    } else {
        const { runMobileReplay } = proxyActivities<MobileActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.MOBILE,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runMobileReplay({ runId });
    }
}
