import { describe, expect, it, vi, beforeEach } from "vitest";
import { recordAppStates, recordEnvironmentReady } from "../../src/db";
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
    recordAppsPending: vi.fn().mockResolvedValue(undefined),
    recordAppStates: vi.fn().mockResolvedValue(undefined),
    recordBuildFinished: vi.fn().mockResolvedValue(undefined),
    recordEnvironmentCreated: vi.fn().mockResolvedValue(undefined),
    recordEnvironmentManifest: vi.fn().mockResolvedValue(undefined),
    recordEnvironmentReady: vi.fn().mockResolvedValue(undefined),
    recordPhaseChanged: vi.fn().mockResolvedValue(undefined),
    recordResolvedConfig: vi.fn().mockResolvedValue(undefined),
}));

const namespace = "preview-acme-web-pr-7";

describe("PreviewPipeline deploy supersede handling", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("stops after deployApps if cancellation arrives before terminal env writes", async () => {
        const controller = new AbortController();
        const deployer = {
            deployInfra: vi.fn().mockResolvedValue({
                namespace,
                awsSecretsByApp: new Map(),
                bypassToken: "bypass-token",
            }),
            deployApps: vi.fn().mockImplementation(async () => {
                controller.abort();
                return {
                    namespace,
                    urls: { web: "https://web.preview" },
                    appOutcomes: { web: { status: "ok", url: "https://web.preview" } },
                    bypassToken: "bypass-token",
                };
            }),
            updateStatus: vi.fn().mockResolvedValue(undefined),
            getNamespaceName: vi.fn().mockReturnValue(namespace),
            getDomain: vi.fn().mockReturnValue("preview.example.com"),
            getSecret: vi.fn().mockReturnValue("secret"),
        };
        const pipeline = new PreviewPipeline({
            provider: {} as never,
            builder: {} as never,
            deployer: deployer as never,
            awsSecretsFetcher: {} as never,
            addonManager: {} as never,
            registryUrl: "registry.example.com",
            dockerHubMirror: "",
        });

        await expect(
            pipeline.deployEnvironment(
                {
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
                        version: 1,
                        apps: [{ name: "web", port: 3000 }],
                        services: [],
                        addons: [],
                        hooks: { pre_deploy: [], post_deploy: [] },
                    }),
                    imageTags: { web: "registry.example.com/acme/web:web" },
                    addonOutputs: {},
                    buildOutcomes: {
                        web: {
                            status: "success",
                            imageTag: "registry.example.com/acme/web:web",
                            durationMs: 1,
                        },
                    },
                    addons: [],
                    warnings: [],
                    primaryAppNames: ["web"],
                },
                controller.signal,
            ),
        ).rejects.toThrow();

        // Only the pre-deploy "deploying" seed ran; the terminal per-app state
        // write (step 6) sits behind the post-deployApps cancellation checkpoint,
        // so it never fires on a superseded run.
        expect(recordAppStates).toHaveBeenCalledTimes(1);
        expect(deployer.updateStatus).not.toHaveBeenCalledWith(
            "acme/web",
            7,
            expect.objectContaining({ status: "ready" }),
        );
        expect(recordEnvironmentReady).not.toHaveBeenCalled();
    });
});
