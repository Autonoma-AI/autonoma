import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreviewDeployEvent, PreviewkitActivities } from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import { previewDeployWorkflow } from "../src/workflows/previewkit.workflow";

// Bundle just the previewkit workflow for the in-memory worker.
const workflowsPath = new URL("../src/workflows/previewkit.workflow.ts", import.meta.url).pathname;

const event: PreviewDeployEvent = {
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

/**
 * Mocked activities (mocking activities is expected for workflow tests - it is
 * the DB we never mock). Each pushes its name onto `calls` so we can assert the
 * orchestration order and which steps ran.
 */
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
                imageTags: { api: "registry/acme/web:api-pr-7-abc1234" },
                addonOutputs: {},
                buildOutcomes: {},
                addons: [],
                warnings: [],
                primaryAppNames: ["api"],
            };
        },
        async deployPreviewEnvironment() {
            calls.push("deploy");
            return {
                ready: true,
                readyCount: 1,
                totalCount: 1,
                urls: { api: "https://api.preview" },
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

async function runWorkflow(workflowId: string, activities: PreviewkitActivities): Promise<void> {
    const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: TaskQueue.PREVIEWKIT,
        workflowsPath,
        activities,
    });

    await worker.runUntil(
        testEnv.client.workflow.execute(previewDeployWorkflow, {
            workflowId,
            taskQueue: TaskQueue.PREVIEWKIT,
            args: [{ event }],
        }),
    );
}

describe("previewDeployWorkflow", () => {
    it("runs prepare -> build -> deploy -> finalize for a happy path", async () => {
        const calls: string[] = [];
        await runWorkflow("pk-happy", makeActivities(calls));
        expect(calls).toEqual(["prepare", "build", "deploy", "finalize"]);
        expect(calls).not.toContain("fail");
    });

    it("stops after prepare when the repo opted out (skipped)", async () => {
        const calls: string[] = [];
        const activities = makeActivities(calls, {
            async preparePreviewDeploy() {
                calls.push("prepare");
                return { skipped: true, namespace: "", commentId: "", feedbackEnabled: false };
            },
        });
        await runWorkflow("pk-skip", activities);
        expect(calls).toEqual(["prepare"]);
    });

    it("runs the failure finalizer and surfaces the error when deploy fails", async () => {
        const calls: string[] = [];
        const activities = makeActivities(calls, {
            async deployPreviewEnvironment() {
                calls.push("deploy");
                throw new Error("deploy blew up");
            },
        });
        await expect(runWorkflow("pk-fail", activities)).rejects.toThrow();
        expect(calls).toContain("fail");
        expect(calls).not.toContain("finalize");
    });
});
