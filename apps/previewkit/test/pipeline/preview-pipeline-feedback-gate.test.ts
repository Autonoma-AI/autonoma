import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/load-config";
import { PreviewPipeline } from "../../src/pipeline/preview-pipeline";

/** The onboarding step the pipeline reads; `completed` is the only one that means "live". */
let onboardingStep: string | undefined = "completed";

vi.mock("@autonoma/db", () => ({
    db: {
        application: {
            findUnique: vi.fn(async () => ({
                id: "app_1",
                onboardingState: { step: onboardingStep },
            })),
        },
    },
    Prisma: { DbNull: null },
}));

vi.mock("../../src/config/load-config", () => ({
    loadConfig: vi.fn(async () => ({
        version: 2,
        apps: [{ name: "web", repository: "acme/web", port: 3000 }],
        services: [],
        hooks: { pre_deploy: [], post_deploy: [] },
    })),
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

const NAMESPACE = "preview-acme-web-pr-7";

function buildPipeline() {
    const provider = { setCommitStatus: vi.fn().mockResolvedValue(undefined) };
    const deployer = { ensureNamespace: vi.fn().mockResolvedValue(NAMESPACE) };
    const pipeline = new PreviewPipeline({
        provider: provider as never,
        builder: {} as never,
        deployer: deployer as never,
        buildSecrets: {} as never,
        registryUrl: "registry.example.com",
        dockerHubMirror: "",
        npmRegistryMirror: "",
    });
    return { pipeline, provider, deployer };
}

function target(prNumber: number) {
    return {
        prNumber,
        repoFullName: "acme/web",
        organizationId: "org_1",
        githubRepositoryId: 123,
        headSha: "abc1234def5678",
        headRef: "feature/login",
    };
}

/**
 * `prepare` decides, once, whether this deploy may write to the customer's pull request. That
 * decision is returned as `feedbackEnabled` and carried into `finalize`/`fail`; the PR comment itself
 * is owned by the analysis run workflow now, so the visible feedback this gate governs is the commit
 * status. It is the single point where an application still being set up is kept out of a repository it
 * has no verdict for yet - and where a live one is let back in.
 */
describe("PreviewPipeline.prepare PR feedback gate", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        onboardingStep = "completed";
    });

    it("stays silent on the pull request while the application is still being set up", async () => {
        onboardingStep = "previewkit_configuring";
        const { pipeline, provider } = buildPipeline();

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ skipped: false, feedbackEnabled: false });
        expect(provider.setCommitStatus).not.toHaveBeenCalled();
    });

    it("sets a pending commit status once the application is live", async () => {
        const { pipeline, provider } = buildPipeline();

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ skipped: false, feedbackEnabled: true });
        expect(provider.setCommitStatus).toHaveBeenCalledWith(
            "acme/web",
            "abc1234def5678",
            "pending",
            expect.any(String),
        );
    });

    // Fails closed: an application with no onboarding row at all is not live. Every caller here is
    // about to write to someone else's repository, so "unknown" must behave like "not yet".
    it("stays silent when the application has no onboarding row", async () => {
        onboardingStep = undefined;
        const { pipeline, provider } = buildPipeline();

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ feedbackEnabled: false });
        expect(provider.setCommitStatus).not.toHaveBeenCalled();
    });

    // Environment 0 is the base preview and has no pull request to comment on. It was quiet before
    // the onboarding gate existed and must stay quiet for that older reason, live or not.
    it("stays silent for the base environment even when the application is live", async () => {
        const { pipeline, provider } = buildPipeline();

        const result = await pipeline.prepare(target(0));

        expect(result).toMatchObject({ feedbackEnabled: false });
        expect(provider.setCommitStatus).not.toHaveBeenCalled();
    });

    // The gate decides feedback only. Holding back the commit status must never hold back the preview,
    // which is the whole point of building during onboarding.
    it("still prepares the environment when feedback is held back", async () => {
        onboardingStep = "previewkit_configuring";
        const { pipeline, deployer } = buildPipeline();

        const result = await pipeline.prepare(target(7));

        expect(result).toMatchObject({ skipped: false, namespace: NAMESPACE });
        expect(deployer.ensureNamespace).toHaveBeenCalledTimes(1);
        expect(loadConfig).toHaveBeenCalledWith("app_1");
    });
});
