import type { PreviewDeployTarget } from "@autonoma/types";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/workflow";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
    LaunchPreviewBuildOutput,
    PreviewBuildJobState,
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
    jobState: PreviewBuildJobState;
    /** When set, the Job read throws it instead of answering. */
    jobStateError?: Error;
    launch: LaunchPreviewBuildOutput;
    gateReports: ReportPreviewBuildWarrantInput[];
    cancelledJobs: string[];
    polls: number;
    /** Resolved once the build's Job exists, so a test can cancel only after there is something to cancel. */
    launched: Promise<void>;
    notifyLaunched: () => void;
}

const JOB_NAME = "pk-deploy-abc123";

const harness: Harness = {
    statuses: [],
    jobState: "running",
    launch: { jobName: JOB_NAME },
    gateReports: [],
    cancelledJobs: [],
    polls: 0,
    launched: Promise.resolve(),
    notifyLaunched: () => undefined,
};

/** Reports the scripted statuses in order, then repeats the last one forever. */
function nextStatus(): ReadPreviewBuildStatusOutput {
    const index = Math.min(harness.polls, harness.statuses.length - 1);
    harness.polls += 1;
    return harness.statuses[index] ?? { state: "missing" };
}

const previewkitActivities: Pick<
    PreviewkitActivities,
    | "launchPreviewBuild"
    | "cancelPreviewBuild"
    | "readPreviewBuildJobState"
    | "readPreviewBuildStatus"
    | "reportPreviewBuildWarrant"
> = {
    launchPreviewBuild() {
        harness.notifyLaunched();
        return Promise.resolve(harness.launch);
    },
    cancelPreviewBuild(input) {
        harness.cancelledJobs.push(input.jobName);
        return Promise.resolve();
    },
    readPreviewBuildJobState() {
        if (harness.jobStateError != null) return Promise.reject(harness.jobStateError);
        return Promise.resolve({ state: harness.jobState });
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
    harness.jobState = "running";
    harness.jobStateError = undefined;
    harness.launch = { jobName: JOB_NAME };
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
async function failure(handle: { result: () => Promise<unknown> }): Promise<{ message: string; type?: string }> {
    try {
        await handle.result();
    } catch (error) {
        let current: unknown = error;
        while (current instanceof Error) {
            if (current instanceof ApplicationFailure) return { message: current.message, type: current.type };
            current = current.cause;
        }
        return { message: error instanceof Error ? error.message : String(error) };
    }
    throw new Error("expected the build to fail, but it succeeded");
}

async function failureMessage(handle: { result: () => Promise<unknown> }): Promise<string> {
    return (await failure(handle)).message;
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

        await expect(failure(handle)).resolves.toMatchObject({
            message: expect.stringContaining("image build exploded"),
            type: "PreviewBuildFailed",
        });
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

    it("gives up when a running Job never claims the environment", async () => {
        harness.statuses = [{ state: "missing" }];

        const handle = await startBuild();

        await expect(failureMessage(handle)).resolves.toContain("did not start within 30 minutes");
    });

    it("fails on the first poll when the Job ended without claiming the environment", async () => {
        harness.statuses = [{ state: "missing" }];
        harness.jobState = "succeeded";

        const handle = await startBuild();

        await expect(failure(handle)).resolves.toMatchObject({
            message: expect.stringContaining("declined to build a preview"),
            type: "PreviewBuildDeclined",
        });
        expect(harness.polls).toBe(1);
    });

    /**
     * A `Failed` Job is two non-zero exits, and the runner exits 0 for every outcome it handles - so this is a
     * crash (an unparseable stored config, an eviction), and it belongs in the failure type, not the refusal one.
     */
    it("reports a Job that died before recording anything as a build failure", async () => {
        harness.statuses = [{ state: "missing" }];
        harness.jobState = "failed";

        const handle = await startBuild();

        await expect(failure(handle)).resolves.toMatchObject({
            message: expect.stringContaining("died before it recorded anything"),
            type: "PreviewBuildFailed",
        });
        expect(harness.polls).toBe(1);
    });

    // A teardown or per-app redeploy takes the environment mutex and deletes this Job without cancelling the
    // workflow. Nothing broke, so it must not land in the build-failure type either.
    it("reports a Job that no longer exists as a refusal, not a failure", async () => {
        harness.statuses = [{ state: "missing" }];
        harness.jobState = "gone";

        const handle = await startBuild();

        await expect(failure(handle)).resolves.toMatchObject({
            message: expect.stringContaining("superseded by a newer deploy"),
            type: "PreviewBuildDeclined",
        });
    });

    it("keeps waiting on an in-flight build even once its Job has ended", async () => {
        harness.statuses = [{ state: "building" }, { state: "building" }, { state: "ready", primaryUrl: PREVIEW_URL }];
        harness.jobState = "succeeded";

        const handle = await startBuild();

        await expect(handle.result()).resolves.toMatchObject({ primaryUrl: PREVIEW_URL });
    });

    it("falls back to the claim timeout when the Job cannot be read at all", async () => {
        harness.statuses = [{ state: "missing" }];
        harness.jobStateError = new Error("the Kubernetes API is unreachable");

        const handle = await startBuild();

        await expect(failureMessage(handle)).resolves.toContain("did not start within 30 minutes");
    });

    it("fails without polling when the launch refuses to create a Job", async () => {
        harness.launch = { declined: "acme/widgets has no preview environment configuration" };

        const handle = await startBuild();

        await expect(failure(handle)).resolves.toMatchObject({
            message: expect.stringContaining("has no preview environment configuration"),
            type: "PreviewBuildDeclined",
        });
        expect(harness.polls).toBe(0);
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
