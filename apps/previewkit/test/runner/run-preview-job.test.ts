import type {
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    PreviewDeployEvent,
} from "@autonoma/types";
import { describe, expect, it, vi } from "vitest";
import type { PreparePreviewResult } from "../../src/pipeline/preview-pipeline";
import type { PreviewJobSpec } from "../../src/runner/job-spec";
import {
    type DeployPipeline,
    type PreviewJobRunners,
    type RunPreviewJobDeps,
    runPreviewJob,
    type TeardownRunner,
} from "../../src/runner/run-preview-job";

const event: PreviewDeployEvent = {
    action: "synchronize",
    prNumber: 42,
    repoFullName: "acme/widgets",
    organizationId: "org_1",
    githubRepositoryId: 99,
    headSha: "abc123def4567890",
    headRef: "feature/x",
    baseSha: "base000",
    baseRef: "main",
    cloneUrl: "https://github.com/acme/widgets.git",
};

const buildOutput: BuildPreviewImagesOutput = {
    mergedConfigJson: "{}",
    imageTags: { app: "registry/app:tag" },
    addonOutputs: {},
    buildOutcomes: {},
    addons: [],
    warnings: [],
    primaryAppNames: ["app"],
};

const deployOutput: DeployPreviewEnvironmentOutput = {
    ready: true,
    readyCount: 1,
    totalCount: 1,
    urls: { app: "https://app.preview" },
    services: [],
    addons: [],
    warnings: [],
};

/** A controllable fake of the slice of PreviewPipeline the runner drives. */
class FakeDeployPipeline implements DeployPipeline {
    prepareResult: PreparePreviewResult = {
        skipped: false,
        namespace: "preview-acme-widgets-pr-42",
        commentId: "comment-1",
        feedbackEnabled: true,
    };
    buildError?: Error;
    deployError?: Error;
    finalizeError?: Error;
    restartError?: Error;
    readonly calls: string[] = [];
    failError?: string;
    buildAppName?: string;
    deployAppName?: string;
    restartAppName?: string;

    async prepare(): Promise<PreparePreviewResult> {
        this.calls.push("prepare");
        return this.prepareResult;
    }
    async build(
        _e: PreviewDeployEvent,
        _ns: string,
        _cfg?: string,
        _signal?: AbortSignal,
        appName?: string,
    ): Promise<BuildPreviewImagesOutput> {
        this.calls.push("build");
        this.buildAppName = appName;
        if (this.buildError != null) throw this.buildError;
        return buildOutput;
    }
    async deployEnvironment(input: DeployPreviewEnvironmentInput): Promise<DeployPreviewEnvironmentOutput> {
        this.calls.push("deploy");
        this.deployAppName = input.appName;
        if (this.deployError != null) throw this.deployError;
        return deployOutput;
    }
    async finalize(): Promise<void> {
        this.calls.push("finalize");
        if (this.finalizeError != null) throw this.finalizeError;
    }
    async fail(_e: unknown, _n: string, _c: string, _f: boolean, error: string): Promise<void> {
        this.calls.push("fail");
        this.failError = error;
    }
    async restartApp(_e: PreviewDeployEvent, _ns: string, appName: string): Promise<void> {
        this.calls.push("restart");
        this.restartAppName = appName;
        if (this.restartError != null) throw this.restartError;
    }
}

class FakeTeardownPipeline implements TeardownRunner {
    readonly torndown: PreviewDeployEvent[] = [];
    async teardown(e: PreviewDeployEvent): Promise<void> {
        this.torndown.push(e);
    }
}

function deploySpec(): PreviewJobSpec {
    return { mode: "deploy", event };
}

function runners(
    deploy: FakeDeployPipeline,
    teardown: FakeTeardownPipeline = new FakeTeardownPipeline(),
): PreviewJobRunners {
    return { previewPipeline: deploy, teardownPipeline: teardown };
}

function fakeDeps(markSuperseded: RunPreviewJobDeps["markSuperseded"] = vi.fn(async () => {})): RunPreviewJobDeps {
    return { markSuperseded, resolveTeardownHeadSha: async (e) => e };
}

describe("runPreviewJob deploy mode", () => {
    it("prepares, builds, deploys, finalizes and reports ready", async () => {
        const pipeline = new FakeDeployPipeline();
        const markSuperseded = vi.fn(async () => {});

        const outcome = await runPreviewJob(
            runners(pipeline),
            deploySpec(),
            new AbortController().signal,
            fakeDeps(markSuperseded),
        );

        expect(outcome).toBe("ready");
        expect(pipeline.calls).toEqual(["prepare", "build", "deploy", "finalize"]);
        expect(markSuperseded).not.toHaveBeenCalled();
    });

    it("returns skipped and never builds when prepare opts out", async () => {
        const pipeline = new FakeDeployPipeline();
        pipeline.prepareResult = { skipped: true };

        const outcome = await runPreviewJob(runners(pipeline), deploySpec(), new AbortController().signal, fakeDeps());

        expect(outcome).toBe("skipped");
        expect(pipeline.calls).toEqual(["prepare"]);
    });

    it("runs the failure finalizer when the build fails (not aborted)", async () => {
        const pipeline = new FakeDeployPipeline();
        pipeline.buildError = new Error("dockerfile broke");
        const markSuperseded = vi.fn(async () => {});

        const outcome = await runPreviewJob(
            runners(pipeline),
            deploySpec(),
            new AbortController().signal,
            fakeDeps(markSuperseded),
        );

        expect(outcome).toBe("deploy_failed");
        expect(pipeline.calls).toEqual(["prepare", "build", "fail"]);
        expect(pipeline.failError).toContain("dockerfile broke");
        expect(markSuperseded).not.toHaveBeenCalled();
    });

    it("leaves the environment ready (no fail finalizer) when only finalize fails", async () => {
        const pipeline = new FakeDeployPipeline();
        pipeline.finalizeError = new Error("github comment failed");

        const outcome = await runPreviewJob(runners(pipeline), deploySpec(), new AbortController().signal, fakeDeps());

        expect(outcome).toBe("finalize_failed");
        expect(pipeline.calls).toEqual(["prepare", "build", "deploy", "finalize"]);
        expect(pipeline.failError).toBeUndefined();
    });

    it("supersedes (build row only, no failure) when aborted by SIGTERM", async () => {
        const pipeline = new FakeDeployPipeline();
        pipeline.buildError = new Error("buildctl aborted");
        const markSuperseded = vi.fn(async () => {});
        const controller = new AbortController();
        controller.abort();

        const outcome = await runPreviewJob(
            runners(pipeline),
            deploySpec(),
            controller.signal,
            fakeDeps(markSuperseded),
        );

        expect(outcome).toBe("superseded");
        expect(pipeline.failError).toBeUndefined();
        expect(markSuperseded).toHaveBeenCalledWith("preview-acme-widgets-pr-42", event.headSha);
    });
});

describe("runPreviewJob teardown mode", () => {
    it("tears down the environment", async () => {
        const teardown = new FakeTeardownPipeline();
        const outcome = await runPreviewJob(
            runners(new FakeDeployPipeline(), teardown),
            { mode: "teardown", event },
            new AbortController().signal,
            fakeDeps(),
        );

        expect(outcome).toBe("torn_down");
        expect(teardown.torndown).toHaveLength(1);
        expect(teardown.torndown[0]?.repoFullName).toBe("acme/widgets");
    });
});

describe("runPreviewJob redeploy-app mode", () => {
    const redeploySpec = (redeployMode: "rebuild" | "restart"): PreviewJobSpec => ({
        mode: "redeploy-app",
        event,
        namespace: "preview-acme-widgets-pr-42",
        appName: "web",
        redeployMode,
    });

    it("rebuild: builds and deploys scoped to the one app", async () => {
        const pipeline = new FakeDeployPipeline();
        const outcome = await runPreviewJob(
            runners(pipeline),
            redeploySpec("rebuild"),
            new AbortController().signal,
            fakeDeps(),
        );

        expect(outcome).toBe("redeployed");
        expect(pipeline.calls).toEqual(["build", "deploy"]);
        expect(pipeline.buildAppName).toBe("web");
        expect(pipeline.deployAppName).toBe("web");
    });

    it("restart: re-rolls the one app's pods (no build/deploy)", async () => {
        const pipeline = new FakeDeployPipeline();
        const outcome = await runPreviewJob(
            runners(pipeline),
            redeploySpec("restart"),
            new AbortController().signal,
            fakeDeps(),
        );

        expect(outcome).toBe("restarted");
        expect(pipeline.calls).toEqual(["restart"]);
        expect(pipeline.restartAppName).toBe("web");
    });

    it("reports redeploy_failed on a genuine failure (no env finalizer, no markSuperseded)", async () => {
        const pipeline = new FakeDeployPipeline();
        pipeline.buildError = new Error("app build broke");
        const markSuperseded = vi.fn(async () => {});

        const outcome = await runPreviewJob(
            runners(pipeline),
            redeploySpec("rebuild"),
            new AbortController().signal,
            fakeDeps(markSuperseded),
        );

        expect(outcome).toBe("redeploy_failed");
        expect(pipeline.calls).toEqual(["build"]);
        expect(markSuperseded).not.toHaveBeenCalled();
    });

    it("supersedes (no DB write) when aborted by SIGTERM", async () => {
        const pipeline = new FakeDeployPipeline();
        pipeline.buildError = new Error("buildctl aborted");
        const markSuperseded = vi.fn(async () => {});
        const controller = new AbortController();
        controller.abort();

        const outcome = await runPreviewJob(
            runners(pipeline),
            redeploySpec("rebuild"),
            controller.signal,
            fakeDeps(markSuperseded),
        );

        expect(outcome).toBe("superseded");
        expect(markSuperseded).not.toHaveBeenCalled();
    });
});
