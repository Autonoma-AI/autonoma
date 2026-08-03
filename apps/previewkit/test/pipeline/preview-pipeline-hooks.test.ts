import type { DeployPreviewEnvironmentInput } from "@autonoma/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { failInFlightApps, recordEnvironmentReady } from "../../src/db";
import { runHookJob } from "../../src/deployer/hook-job-runner";
import { PreviewPipeline } from "../../src/pipeline/preview-pipeline";

vi.mock("@autonoma/db", () => ({
    db: {},
    Prisma: { DbNull: null },
}));

vi.mock("../../src/env", () => ({
    env: {
        APP_URL: "https://app.example.com",
        GITHUB_COMMENT_ASSET_BASE_URL: undefined,
        BYPASS_TOKEN_KEY: "test-key",
    },
}));

vi.mock("../../src/db", () => ({
    failInFlightApps: vi.fn().mockResolvedValue(undefined),
    recordAppsPending: vi.fn().mockResolvedValue(undefined),
    recordAppRedeployOutcome: vi.fn().mockResolvedValue(undefined),
    recordAppStates: vi.fn().mockResolvedValue(undefined),
    recordBuildFinished: vi.fn().mockResolvedValue(undefined),
    recordEnvironmentCreated: vi.fn().mockResolvedValue(undefined),
    recordEnvironmentReady: vi.fn().mockResolvedValue(undefined),
    recordPhaseChanged: vi.fn().mockResolvedValue(undefined),
    recordResolvedConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/deployer/hook-job-runner", () => ({
    runHookJob: vi.fn().mockResolvedValue(undefined),
}));

const namespace = "preview-acme-web-pr-7";

function createPipeline() {
    const deployer = {
        deployInfra: vi.fn().mockResolvedValue({
            namespace,
            secretsByApp: new Map(),
            bypassToken: "bypass-token",
        }),
        deployApps: vi.fn().mockResolvedValue({
            namespace,
            urls: { web: "https://web.preview" },
            appOutcomes: { web: { status: "ok", url: "https://web.preview" } },
            bypassToken: "bypass-token",
        }),
        updateStatus: vi.fn().mockResolvedValue(undefined),
        getNamespaceName: vi.fn().mockReturnValue(namespace),
        getDomain: vi.fn().mockReturnValue("preview.example.com"),
        getSecret: vi.fn().mockReturnValue("secret"),
        getKubeConfig: vi.fn().mockReturnValue({}),
        getEnvInjector: vi.fn().mockReturnValue({ resolveConnections: vi.fn().mockReturnValue({}) }),
    };
    const pipeline = new PreviewPipeline({
        provider: {} as never,
        builder: {} as never,
        deployer: deployer as never,
        buildSecrets: {} as never,
        registryUrl: "registry.example.com",
        dockerHubMirror: "",
        npmRegistryMirror: "",
    });
    return { pipeline, deployer };
}

function deployInput(hooks: {
    pre_deploy: Array<{ app: string; command: string }>;
    post_deploy: Array<{ app: string; command: string }>;
}): DeployPreviewEnvironmentInput {
    return {
        event: {
            action: "synchronize",
            prNumber: 7,
            repoFullName: "acme/web",
            organizationId: "org_1",
            githubRepositoryId: 123,
            headSha: "abc1234def5678",
            headRef: "feature/login",
            baseSha: "",
            baseRef: "",
            cloneUrl: "https://github.com/acme/web.git",
        },
        namespace,
        commentId: "100",
        mergedConfigJson: JSON.stringify({
            version: 2,
            apps: [{ name: "web", repository: "acme/web", port: 3000 }],
            services: [],
            hooks,
        }),
        imageTags: { web: "registry.example.com/acme/web:web" },
        buildOutcomes: {
            web: { status: "success", imageTag: "registry.example.com/acme/web:web", durationMs: 1 },
        },
        warnings: [],
    };
}

describe("PreviewPipeline deploy hook failures", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("aborts the deploy when a pre-deploy hook fails, without marking the environment ready", async () => {
        vi.mocked(runHookJob).mockRejectedValue(new Error('Hook Job "web-hook-a1b2" failed.\n[exit 1] prisma: boom'));
        const { pipeline, deployer } = createPipeline();

        await expect(
            pipeline.deployEnvironment(
                deployInput({ pre_deploy: [{ app: "web", command: "npx prisma db push" }], post_deploy: [] }),
            ),
        ).rejects.toThrow(/web-hook-a1b2/);

        expect(deployer.deployApps).not.toHaveBeenCalled();
        expect(recordEnvironmentReady).not.toHaveBeenCalled();
    });

    it("keeps the environment ready when a post-deploy hook fails, and reports it as a warning", async () => {
        vi.mocked(runHookJob).mockRejectedValue(
            new Error('Hook Job "web-hook-c3d4" failed.\n[exit 1] Error\nmigration 003 failed: relation exists'),
        );
        const { pipeline } = createPipeline();

        const result = await pipeline.deployEnvironment(
            deployInput({ pre_deploy: [], post_deploy: [{ app: "web", command: "npm run migrate" }] }),
        );

        expect(result.ready).toBe(true);
        expect(recordEnvironmentReady).toHaveBeenCalled();
        expect(result.warnings).toHaveLength(1);
        expect(result.warnings[0]).toContain('Post-deploy hook for "web" failed');
        expect(result.warnings[0]).toContain("npm run migrate");
        // The tail of the hook log carries the actual reason, collapsed onto one line.
        expect(result.warnings[0]).toContain("migration 003 failed: relation exists");
        expect(result.warnings[0]).not.toContain("\n");
    });

    it("leaves no app row in flight after a failed deploy", async () => {
        const { pipeline } = createPipeline();

        await pipeline.fail(
            deployInput({ pre_deploy: [], post_deploy: [] }).event,
            namespace,
            "",
            false,
            'Hook Job "web-hook-a1b2" failed.',
        );

        expect(failInFlightApps).toHaveBeenCalledWith(namespace, 'Hook Job "web-hook-a1b2" failed.');
    });
});
