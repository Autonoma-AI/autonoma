import type { PreviewDeployTarget } from "@autonoma/types";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/workflow";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
    PreviewkitActivities,
    ReadPreviewBuildStatusOutput,
    ReportPreviewBuildWarrantInput,
} from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import { previewBuildWorkflow } from "../src/workflows/preview-build.workflow";
import { teardownTestWorkflowEnvironment } from "./fixtures/teardown-test-workflow-environment";
import { createTimeSkippingTestEnvironment } from "./fixtures/test-workflow-environment";
import { workflowBundle } from "./fixtures/workflow-bundle";

/**
 * One commit's build, run for real in the time-skipping environment: never report a preview it cannot back with a
 * URL, and never leave a Job running once its run is abandoned.
 */

const PREVIEW_URL = "https://web-pr-7.preview.example.com";
const SDK_URL = "https://api-pr-7.preview.example.com";

interface Harness {
    /** A test drives the build's outcome entirely through this. */
    statuses: ReadPreviewBuildStatusOutput[];
    gateReports: ReportPreviewBuildWarrantInput[];
    cancelledJobs: string[];
    polls: number;
    /** Resolved once the build's Job exists, so a test can cancel only after there is something to cancel. */
    launched: Promise<void>;
    notifyLaunched: () => void;
}

const harness: Harness = {
    statuses: [],
    gateReports: [],
    cancelledJobs: [],
    polls: 0,
    launched: Promise.resolve(),
    notifyLaunched: () => undefined,
};

const JOB_NAME = "pk-deploy-abc123";

/** Reports the scripted statuses in order, then repeats the last one forever. */
function nextStatus(): ReadPreviewBuildStatusOutput {
    const index = Math.min(harness.polls, harness.statuses.length - 1);
    harness.polls += 1;
    return harness.statuses[index] ?? { state: "missing" };
}

const previewkitActivities: Pick<
    PreviewkitActivities,
    "launchPreviewBuild" | "cancelPreviewBuild" | "readPreviewBuildStatus" | "reportPreviewBuildWarrant"
> = {
    launchPreviewBuild() {
        harness.notifyLaunched();
        return Promise.resolve({ jobName: JOB_NAME });
    },
    cancelPreviewBuild(input) {
        harness.cancelledJobs.push(input.jobName);
        return Promise.resolve();
    },
    readPreviewBuildStatus() {
        return Promise.resolve(nextStatus());
    },
    reportPreviewBuildWarrant(input) {
        harness.gateReports.push(input);
        return Promise.resolve();
    },
};

let env: TestWorkflowEnvironment;
let worker: Worker;
let runner: Promise<unknown>;
let executionCounter = 0;

beforeAll(async () => {
    env = await createTimeSkippingTestEnvironment();
    worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: TaskQueue.GENERAL,
        workflowBundle: workflowBundle(),
        activities: previewkitActivities,
    });
    runner = worker.run();
});

afterAll(async () => {
    await teardownTestWorkflowEnvironment({ env, workers: [worker], runner });
});

beforeEach(() => {
    harness.statuses = [{ state: "ready", primaryUrl: PREVIEW_URL, sdkAppUrl: SDK_URL }];
    harness.gateReports = [];
    harness.cancelledJobs = [];
    harness.polls = 0;
    harness.launched = new Promise((resolve) => {
        harness.notifyLaunched = resolve;
    });
});

function deployEvent(): PreviewDeployTarget {
    executionCounter += 1;
    return {
        prNumber: 7,
        repoFullName: `acme/widgets-${executionCounter}`,
        organizationId: "org-1",
        githubRepositoryId: 99,
        headSha: `head-${executionCounter}`,
        headRef: "feature/checkout",
        branchId: "branch-1",
    };
}

/** `handle.result()` rejects with a generic wrapper; the verdict is the ApplicationFailure on its cause chain. */
async function failureMessage(handle: { result: () => Promise<unknown> }): Promise<string> {
    try {
        await handle.result();
    } catch (error) {
        let current: unknown = error;
        while (current instanceof Error) {
            if (current instanceof ApplicationFailure) return current.message;
            current = current.cause;
        }
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error("expected the build to fail, but it succeeded");
}

function startBuild() {
    return env.client.workflow.start(previewBuildWorkflow, {
        taskQueue: TaskQueue.GENERAL,
        workflowId: `preview-build-test-${executionCounter}`,
        args: [{ target: deployEvent(), reason: "analysis_selected_tests", branchId: "branch-1" }],
    });
}

describe("previewBuildWorkflow", () => {
    it("returns the preview's origins once the build is live", async () => {
        const handle = await startBuild();

        await expect(handle.result()).resolves.toEqual({ primaryUrl: PREVIEW_URL, sdkAppUrl: SDK_URL });
    });

    it("records why it was built before doing anything else", async () => {
        const handle = await startBuild();
        await handle.result();

        expect(harness.gateReports.map((report) => report.reason)).toEqual(["analysis_selected_tests"]);
    });

    it("waits out an unclaimed environment and a build still in flight", async () => {
        harness.statuses = [
            { state: "missing" },
            { state: "missing" },
            { state: "building" },
            { state: "ready", primaryUrl: PREVIEW_URL },
        ];

        const handle = await startBuild();

        await expect(handle.result()).resolves.toMatchObject({ primaryUrl: PREVIEW_URL });
        expect(harness.polls).toBe(4);
    });

    it("fails with the environment's own error when the build fails", async () => {
        harness.statuses = [{ state: "failed", error: "image build exploded" }];

        const handle = await startBuild();

        await expect(failureMessage(handle)).resolves.toContain("image build exploded");
    });

    // Reading the per-commit build row is what stops an abandoned build polling a foreign head for its whole
    // settle budget and then giving up with a misleading "did not settle".
    it("fails promptly when a newer commit superseded this one", async () => {
        harness.statuses = [{ state: "building" }, { state: "superseded" }];

        const handle = await startBuild();

        await expect(failureMessage(handle)).resolves.toContain("superseded");
        expect(harness.polls).toBe(2);
    });

    // A ready environment whose primary app has no URL is not a preview.
    it("fails when the preview is ready but exposes no primary URL, naming why", async () => {
        // The environment says ready while the app the tests browse failed to build - 10% of ready environments
        // are in this shape. The message has to name that, or an operator sees only "no primary URL".
        harness.statuses = [{ state: "ready", error: "the primary app `main-app` build failed" }];

        const handle = await startBuild();

        await expect(failureMessage(handle)).resolves.toContain("exposes no primary URL");
        await expect(failureMessage(handle)).resolves.toContain("`main-app` build failed");
    });

    // A Job that dies before its first write - evicted, OOM, image pull - never claims the environment, and is
    // bounded far below the settle budget.
    it("gives up when the Job never claims the environment", async () => {
        harness.statuses = [{ state: "missing" }];

        const handle = await startBuild();

        await expect(failureMessage(handle)).resolves.toContain("did not start within 30 minutes");
    });

    // The whole reason the build is its own workflow. Stopped by NAME, never by the environment label, which is
    // per (repo, PR) and would kill whichever newer commit had already launched.
    it("stops its Job by name when cancelled mid-build", async () => {
        harness.statuses = [{ state: "building" }];

        const handle = await startBuild();
        await harness.launched;
        await handle.cancel();

        await expect(handle.result()).rejects.toThrow();
        expect(harness.cancelledJobs).toEqual([JOB_NAME]);
    });
});
