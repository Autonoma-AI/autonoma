import type { AnalysisRunOutcome } from "@autonoma/types";
import { Context } from "@temporalio/activity";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AnalysisActivities } from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import { analysisWorkflow } from "../src/workflows/analysis.workflow";
import { createTimeSkippingTestEnvironment } from "./fixtures/test-workflow-environment";

const workflowsPath = new URL("../src/workflows/index.ts", import.meta.url).pathname;
const snapshotId = "analysis-snapshot";
let sequence = 0;

const settlements: AnalysisRunOutcome[] = [];
let impactFailure: Error | undefined;
let blockImpact = false;
let impactStarted: Promise<void>;
let notifyImpactStarted: () => void;

const activities: AnalysisActivities = {
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

beforeAll(async () => {
    env = await createTimeSkippingTestEnvironment();
    worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.DIFFS,
        workflowsPath,
        activities,
        bundlerOptions: {
            webpackConfigHook: (config) => {
                config.optimization = { ...config.optimization, minimize: false };
                return config;
            },
        },
    });
    runner = worker.run();
}, 120_000);

afterAll(async () => {
    worker.shutdown();
    await runner;
    await env.teardown();
});

beforeEach(() => {
    settlements.length = 0;
    impactFailure = undefined;
    blockImpact = false;
    impactStarted = new Promise((resolve) => {
        notifyImpactStarted = resolve;
    });
});

function runWorkflow(): Promise<void> {
    sequence += 1;
    return env.client.workflow.execute(analysisWorkflow, {
        taskQueue: TaskQueue.DIFFS,
        workflowId: `analysis-workflow-${sequence}`,
        args: [{ snapshotId }],
    });
}

async function startWorkflow() {
    sequence += 1;
    return env.client.workflow.start(analysisWorkflow, {
        taskQueue: TaskQueue.DIFFS,
        workflowId: `analysis-workflow-${sequence}`,
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
