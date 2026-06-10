import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreviewDeployEvent, PreviewkitActivities } from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import { previewTeardownWorkflow } from "../src/workflows/previewkit-teardown.workflow";
import { previewDeployWorkflow } from "../src/workflows/previewkit.workflow";

// Bundle both previewkit workflows so the shared-workflowId test can run a
// deploy and a teardown against the same in-memory worker.
const workflowsPath = new URL("./fixtures/previewkit-workflows.ts", import.meta.url).pathname;

const closedEvent: PreviewDeployEvent = {
    action: "closed",
    prNumber: 7,
    repoFullName: "acme/web",
    organizationId: "org_1",
    githubRepositoryId: 123,
    // Webhook close events don't carry the sha; the activity resolves it.
    headSha: "",
    headRef: "",
    baseSha: "",
    baseRef: "",
    cloneUrl: "",
};

const openedEvent: PreviewDeployEvent = {
    action: "opened",
    prNumber: 7,
    repoFullName: "acme/web",
    organizationId: "org_1",
    githubRepositoryId: 123,
    headSha: "abc1234def5678",
    headRef: "feature/login",
    baseSha: "",
    baseRef: "",
    cloneUrl: "https://github.com/acme/web.git",
};

/** Mocked activities; each pushes its name onto `calls` to assert what ran. */
function makeActivities(calls: string[], overrides: Partial<PreviewkitActivities> = {}): PreviewkitActivities {
    return {
        async preparePreviewDeploy() {
            calls.push("prepare");
            return { skipped: false, namespace: "preview-acme-web-pr-7", commentId: "100", feedbackEnabled: true };
        },
        async buildPreviewImages() {
            calls.push("build");
            return {
                mergedConfigJson: "{}",
                imageTags: {},
                addonOutputs: {},
                buildOutcomes: {},
                addons: [],
                warnings: [],
                primaryAppNames: [],
            };
        },
        async deployPreviewEnvironment() {
            calls.push("deploy");
            return {
                ready: true,
                readyCount: 1,
                totalCount: 1,
                urls: {},
                services: [],
                addons: [],
                warnings: [],
            };
        },
        async finalizePreviewDeploy() {
            calls.push("finalize");
        },
        async failPreviewDeploy() {
            calls.push("fail");
        },
        async teardownPreviewEnvironment() {
            calls.push("teardown");
        },
        ...overrides,
    };
}

let testEnv: TestWorkflowEnvironment;

beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
});

afterAll(async () => {
    await testEnv?.teardown();
});

async function createWorker(activities: PreviewkitActivities): Promise<Worker> {
    return await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: TaskQueue.PREVIEWKIT,
        workflowsPath,
        activities,
    });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describe("previewTeardownWorkflow", () => {
    it("runs the teardown activity", async () => {
        const calls: string[] = [];
        const worker = await createWorker(makeActivities(calls));

        await worker.runUntil(
            testEnv.client.workflow.execute(previewTeardownWorkflow, {
                workflowId: "pk-teardown-happy",
                taskQueue: TaskQueue.PREVIEWKIT,
                args: [{ event: closedEvent }],
            }),
        );

        expect(calls).toEqual(["teardown"]);
    });

    it("fails the workflow when the teardown activity exhausts retries", async () => {
        const calls: string[] = [];
        const activities = makeActivities(calls, {
            async teardownPreviewEnvironment() {
                calls.push("teardown");
                throw new Error("namespace deletion blew up");
            },
        });
        const worker = await createWorker(activities);

        await expect(
            worker.runUntil(
                testEnv.client.workflow.execute(previewTeardownWorkflow, {
                    workflowId: "pk-teardown-fail",
                    taskQueue: TaskQueue.PREVIEWKIT,
                    args: [{ event: closedEvent }],
                }),
            ),
        ).rejects.toThrow();

        // 3 attempts per the retry policy, then the workflow fails loudly.
        expect(calls).toEqual(["teardown", "teardown", "teardown"]);
    });

    it("terminates an in-flight deploy when started at the same workflowId", async () => {
        const calls: string[] = [];
        let releaseBuild = (): void => undefined;
        const buildGate = new Promise<void>((resolve) => {
            releaseBuild = resolve;
        });

        const activities = makeActivities(calls, {
            async buildPreviewImages() {
                calls.push("build-started");
                await buildGate;
                return {
                    mergedConfigJson: "{}",
                    imageTags: {},
                    addonOutputs: {},
                    buildOutcomes: {},
                    addons: [],
                    warnings: [],
                    primaryAppNames: [],
                };
            },
        });
        const worker = await createWorker(activities);

        await worker.runUntil(async () => {
            // The gate must always open, or the pending build activity blocks
            // worker drain and turns an assertion failure into a test timeout.
            try {
                const workflowId = "pk-shared-mutex";

                const deployHandle = await testEnv.client.workflow.start(previewDeployWorkflow, {
                    workflowId,
                    taskQueue: TaskQueue.PREVIEWKIT,
                    args: [{ event: openedEvent }],
                });
                await waitFor(() => calls.includes("build-started"));

                // What triggerPreviewTeardown does: same workflowId, TERMINATE_EXISTING.
                const teardownHandle = await testEnv.client.workflow.start(previewTeardownWorkflow, {
                    workflowId,
                    workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
                    taskQueue: TaskQueue.PREVIEWKIT,
                    args: [{ event: closedEvent }],
                });
                await teardownHandle.result();

                // Pin the deploy's run - describing by workflowId alone returns
                // the latest run at that ID, which is now the teardown.
                const deployRun = testEnv.client.workflow.getHandle(workflowId, deployHandle.firstExecutionRunId);
                const deployDescription = await deployRun.describe();
                expect(deployDescription.status.name).toBe("TERMINATED");
                expect(calls).toContain("teardown");
                // The superseded deploy never reached its failure finalizer.
                expect(calls).not.toContain("fail");
            } finally {
                releaseBuild();
            }
        });
    });
});
