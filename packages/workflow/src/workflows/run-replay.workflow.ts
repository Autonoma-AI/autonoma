import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities, GeneralActivities, MobileActivities, WebActivities } from "../activities";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture } from "../types";

const scenario = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.GENERAL,
});

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
}

export async function runReplayWorkflow(input: RunReplayInput): Promise<void> {
    const { runId, architecture, scenarioId } = input;

    let scenarioInstanceId: string | undefined;

    // Steps 1-2 are wrapped in a single try/finally so that scenarioDown always
    // runs even if scenarioUp itself fails mid-way
    try {
        // Step 1: Scenario up (if needed)
        if (scenarioId != null) {
            log.info("Starting scenario setup", { runId, scenarioId });
            const result = await scenario.scenarioUp({
                scenarioJobType: "run",
                entityId: runId,
                scenarioId,
            });
            scenarioInstanceId = result.scenarioInstanceId;
            log.info("Scenario setup complete", { runId, scenarioInstanceId });
        } else {
            log.warn("Scenario setup skipped: run has no linked scenario", { runId });
        }

        // Step 2: Run the replay execution agent
        await runReplayExecution(architecture, runId);
    } catch (error) {
        const reason = error instanceof Error ? error.message : "Replay failed";
        log.error("Run replay failed, marking as failed", { runId, reason });
        await CancellationScope.nonCancellable(() => general.markRunFailed({ runId, reason }));
        throw error;
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
                postSteps.push(scenario.scenarioDown({ scenarioInstanceId }));
            }

            await Promise.allSettled(postSteps);
        });
    }
}

async function runReplayExecution(architecture: WorkflowArchitecture, runId: string): Promise<void> {
    if (architecture === "WEB") {
        const { runWebReplay } = proxyActivities<WebActivities>({
            startToCloseTimeout: "90m",
            taskQueue: TaskQueue.WEB,
            heartbeatTimeout: "2m",
            retry: { maximumAttempts: 1 },
        });
        await runWebReplay({ runId });
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
