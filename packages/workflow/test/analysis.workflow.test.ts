import type { AnalysisRunOutcome } from "@autonoma/types";
import { Context } from "@temporalio/activity";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisActivities } from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import { analysisWorkflow } from "../src/workflows/analysis.workflow";
import { teardownTestWorkflowEnvironment } from "./fixtures/teardown-test-workflow-environment";
import { terminateAbandonedExecutions } from "./fixtures/terminate-abandoned-executions";
import { createTimeSkippingTestEnvironment } from "./fixtures/test-workflow-environment";
import { warmUpWorkflowWorker } from "./fixtures/warm-up-workflow-worker";
import { workflowBundle } from "./fixtures/workflow-bundle";

const snapshotId = "analysis-snapshot";
let sequence = 0;

const settlements: AnalysisRunOutcome[] = [];
let impactFailure: Error | undefined;
let blockImpact = false;
let impactStarted: Promise<void>;
let notifyImpactStarted: () => void;

const activities: AnalysisActivities = {
    async openMergeGate() {
        return { status: "skipped" };
    },
    async runImpactAnalysis() {
        if (impactFailure != null) throw impactFailure;
        if (blockImpact) {
            notifyImpactStarted();
            await new Promise<void>((_resolve, reject) => {
                Context.current().cancellationSignal.addEventListener("abort", () => reject(new Error("cancelled")), {
                    once: true,
                });
            });
        }
        return { targets: [], reasoning: "No affected tests" };
    },
    async runReporter() {
        return { issuesOpened: 0, issuesCarried: 0, issuesResolved: 0, verdict: "passed", clientBugCount: 0 };
    },
    async settleAnalysisRun(input) {
        settlements.push(input.outcome);
        return { settled: true, generationsFailed: 0, discardedChangeCount: 0 };
    },
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let runner: Promise<void>;

/** What the current test started, so anything it abandons is stopped before the next test runs. */
let startedWorkflowIds: string[] = [];

beforeAll(async () => {
    env = await createTimeSkippingTestEnvironment();
    worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.DIFFS,
        workflowBundle: workflowBundle(),
        activities,
    });
    runner = worker.run();

    await warmUpWorkflowWorker(() => runWorkflow());
});

afterAll(async () => {
    await teardownTestWorkflowEnvironment({ env, workers: [worker], runner });
});

beforeEach(() => {
    settlements.length = 0;
    impactFailure = undefined;
    blockImpact = false;
    impactStarted = new Promise((resolve) => {
        notifyImpactStarted = resolve;
    });
});

afterEach(async () => {
    await terminateAbandonedExecutions(env, startedWorkflowIds);
    startedWorkflowIds = [];
});

/** Allocates the next execution's id and registers it for the abandoned-execution sweep. */
function nextWorkflowId(): string {
    sequence += 1;
    const workflowId = `analysis-workflow-${sequence}`;
    startedWorkflowIds.push(workflowId);
    return workflowId;
}

function runWorkflow(): Promise<void> {
    return env.client.workflow.execute(analysisWorkflow, {
        taskQueue: TaskQueue.DIFFS,
        workflowId: nextWorkflowId(),
        args: [{ snapshotId }],
    });
}

async function startWorkflow() {
    return env.client.workflow.start(analysisWorkflow, {
        taskQueue: TaskQueue.DIFFS,
        workflowId: nextWorkflowId(),
        args: [{ snapshotId }],
    });
}

describe("analysisWorkflow settlement", () => {
    it("settles a completed pipeline once", async () => {
        await runWorkflow();

        expect(settlements).toEqual([{ kind: "succeeded" }]);
    });

    it("settles a failed pipeline before rethrowing the original error", async () => {
        impactFailure = new Error("impact exploded");

        // Temporal wraps the activity failure for the client, but settlement receives the root error and does not
        // replace it with a settlement failure.
        await expect(runWorkflow()).rejects.toThrow("Workflow execution failed");
        expect(settlements).toEqual([{ kind: "failed", reason: "impact exploded" }]);
    });

    it("settles after cancellation through the non-cancellable scope", async () => {
        blockImpact = true;
        const handle = await startWorkflow();
        await impactStarted;

        await handle.cancel();
        await expect(handle.result()).rejects.toThrow("Workflow execution cancelled");
        expect(settlements).toEqual([{ kind: "failed", reason: expect.any(String) }]);
    });
});
