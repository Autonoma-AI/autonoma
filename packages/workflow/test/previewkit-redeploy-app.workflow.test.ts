import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PreviewDeployEvent, PreviewkitActivities } from "../src/activities";
import { TaskQueue } from "../src/task-queues";
import {
    previewRedeployAppWorkflow,
    type PreviewRedeployAppWorkflowInput,
} from "../src/workflows/previewkit-redeploy-app.workflow";

// Bundle just the per-app redeploy workflow for the in-memory worker.
const workflowsPath = new URL("../src/workflows/previewkit-redeploy-app.workflow.ts", import.meta.url).pathname;

const event: PreviewDeployEvent = {
    action: "synchronize",
    prNumber: 7,
    repoFullName: "acme/web",
    organizationId: "org_1",
    githubRepositoryId: 123,
    headSha: "abc1234def5678",
    headRef: "feature/login",
    baseSha: "",
    baseRef: "",
    cloneUrl: "",
};

/** Mocked activities (the DB is never mocked; activities are). Each records its name. */
function makeActivities(calls: string[], overrides: Partial<PreviewkitActivities> = {}): PreviewkitActivities {
    return {
        async preparePreviewDeploy() {
            calls.push("prepare");
            return { skipped: false, namespace: "preview-acme-web-pr-7", commentId: "", feedbackEnabled: false };
        },
        async buildPreviewImages() {
            calls.push("build");
            return {
                mergedConfigJson: "{}",
                imageTags: { web: "registry/acme/web:web-pr-7-abc1234" },
                addonOutputs: {},
                buildOutcomes: {},
                addons: [],
                warnings: [],
                primaryAppNames: ["web"],
            };
        },
        async deployPreviewEnvironment() {
            calls.push("deploy");
            return {
                ready: true,
                readyCount: 1,
                totalCount: 1,
                urls: { web: "https://web.preview" },
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
        async markPreviewDeploySuperseded() {
            calls.push("markSuperseded");
        },
        async restartPreviewApp() {
            calls.push("restart");
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

async function runWorkflow(
    workflowId: string,
    input: PreviewRedeployAppWorkflowInput,
    activities: PreviewkitActivities,
): Promise<void> {
    const worker = await Worker.create({
        connection: testEnv.nativeConnection,
        taskQueue: TaskQueue.PREVIEWKIT,
        workflowsPath,
        activities,
    });

    await worker.runUntil(
        testEnv.client.workflow.execute(previewRedeployAppWorkflow, {
            workflowId,
            taskQueue: TaskQueue.PREVIEWKIT,
            args: [input],
        }),
    );
}

const baseInput: Omit<PreviewRedeployAppWorkflowInput, "mode"> = {
    event,
    namespace: "preview-acme-web-pr-7",
    appName: "web",
};

describe("previewRedeployAppWorkflow", () => {
    it("rebuild mode runs build -> deploy and skips prepare/finalize/fail", async () => {
        const calls: string[] = [];
        await runWorkflow("pk-redeploy-rebuild", { ...baseInput, mode: "rebuild" }, makeActivities(calls));
        expect(calls).toEqual(["build", "deploy"]);
        expect(calls).not.toContain("prepare");
        expect(calls).not.toContain("finalize");
        expect(calls).not.toContain("fail");
    });

    it("restart mode runs only restartPreviewApp", async () => {
        const calls: string[] = [];
        await runWorkflow("pk-redeploy-restart", { ...baseInput, mode: "restart" }, makeActivities(calls));
        expect(calls).toEqual(["restart"]);
    });

    it("a build failure surfaces without running the env-level fail/finalize finalizers", async () => {
        const calls: string[] = [];
        const activities = makeActivities(calls, {
            async buildPreviewImages() {
                calls.push("build");
                throw new Error("build blew up");
            },
        });

        await expect(
            runWorkflow("pk-redeploy-build-fail", { ...baseInput, mode: "rebuild" }, activities),
        ).rejects.toThrow();
        // build is retried by its activity retry policy, so it may appear more
        // than once - the point is that ONLY build ran: no deploy, and crucially
        // none of the env-level finalizers (fail/finalize) that would flip a
        // healthy multi-app environment to `failed`.
        expect(new Set(calls)).toEqual(new Set(["build"]));
        expect(calls).not.toContain("deploy");
        expect(calls).not.toContain("fail");
        expect(calls).not.toContain("finalize");
    });
});
