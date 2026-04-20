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

export interface RunReplayInput {
    runId: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
    skipIssueBugCreation?: boolean;
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
            const result = await general.scenarioUp({
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
    } finally {
        // Step 3: After replay completes (or fails), run cleanup in parallel.
        // Use allSettled so that a failure in one step does not prevent the others
        // from executing - e.g. a scenarioDown failure must not skip reviewReplay.
        const postSteps: Promise<void>[] = [
            general.reviewReplay({ runId, skipIssueBugCreation: input.skipIssueBugCreation }),
        ];

        if (scenarioInstanceId != null) {
            postSteps.push(general.scenarioDown({ scenarioInstanceId }));
        }

        await Promise.allSettled(postSteps);
    }
}

async function runReplayExecution(architecture: WorkflowArchitecture, runId: string): Promise<void> {
    if (architecture === "WEB") {
        const { runWebReplay } = proxyActivities<WebActivities>({
            startToCloseTimeout: "30m",
            taskQueue: TaskQueue.WEB,
            heartbeatTimeout: "2m",
        });
        await runWebReplay({ runId });
    } else {
        const { runMobileReplay } = proxyActivities<MobileActivities>({
            startToCloseTimeout: "30m",
            taskQueue: TaskQueue.MOBILE,
            heartbeatTimeout: "2m",
        });
        await runMobileReplay({ runId });
    }
}
