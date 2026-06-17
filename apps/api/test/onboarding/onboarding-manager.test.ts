import { createHmac } from "node:crypto";
import { integrationTestSuite } from "@autonoma/integration-test";
import { EncryptionHelper, type ScenarioManager } from "@autonoma/scenario";
import { triggerRefinementLoop } from "@autonoma/workflow";
import { expect, vi } from "vitest";
import { DryRunSubject } from "../../src/routes/onboarding/dry-run-subject";
import { OnboardingManager } from "../../src/routes/onboarding/onboarding-manager";
import {
    InvalidOnboardingStepError,
    OnboardingApplicationNotFoundError,
    OnboardingSdkNotConfiguredError,
} from "../../src/routes/onboarding/states/onboarding-state";
import { OnboardingTestHarness } from "./onboarding-harness";

vi.mock("@autonoma/workflow", () => ({
    triggerRefinementLoop: vi.fn(async () => undefined),
}));

const fakeScenarioManager = {
    discoverWithConfig: async () => ({ models: [] }),
} as unknown as ScenarioManager;
const fakeEncryption = new EncryptionHelper("0".repeat(64));

integrationTestSuite({
    name: "OnboardingManager",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption);
        return { orgId, manager, createApp: () => harness.createApp(orgId) };
    },
    cases: (test) => {
        test("getState upserts if no record exists", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            const state = await manager.getState(appId);
            expect(state.step).toBe("webhook_configuring");
            expect(state.agentConnectedAt).toBeNull();
            expect(state.completedAt).toBeNull();
        });

        test("getState recovers a stale discovering state", async ({ seedResult: { manager, createApp }, harness }) => {
            const appId = await createApp();
            await harness.db.onboardingState.create({
                data: {
                    applicationId: appId,
                    step: "discovering",
                    discoveringStartedAt: new Date(Date.now() - 3 * 60 * 1000),
                },
            });

            const state = await manager.getState(appId);

            expect(state.step).toBe("webhook_configuring");
            expect(state.discoveringStartedAt).toBeNull();
            expect(state.lastDiscoveryError).toBe("Discovery timed out or crashed. Please retry.");
        });

        test("getState keeps a recent discovering state in progress", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.create({
                data: {
                    applicationId: appId,
                    step: "discovering",
                    discoveringStartedAt: new Date(Date.now() - 30 * 1000),
                },
            });

            const state = await manager.getState(appId);

            expect(state.step).toBe("discovering");
            expect(state.discoveryInProgress).toBe(true);
            expect(state.lastDiscoveryError).toBeNull();
        });

        test("full onboarding flow: webhook_configuring -> dry_run_passed -> github -> preview_verified -> completed", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            await harness.seedScenarioWithRecipe(appId, orgId);

            // Advance to dry_run_passed
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "dry_run_passed" },
                update: { step: "dry_run_passed" },
            });
            const afterComplete = await manager.complete(appId, "https://example.com");
            expect(afterComplete.step).toBe("github");
            expect(afterComplete.productionUrl).toBe("https://example.com");

            await linkRepository(harness, appId, 91_001);
            const afterGithub = await manager.completeGithub(appId, orgId);
            expect(afterGithub.step).toBe("preview_environment");
            expect(afterGithub.completedAt).toBeNull();

            await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");
            await manager.acceptDeploymentSignal({
                bodyText: deploymentSignalBody(appId, "https://preview.example.com"),
                signature: deploymentSignalSignature(
                    deploymentSignalBody(appId, "https://preview.example.com"),
                    "shared-secret",
                ),
            });

            const afterSignal = await manager.getState(appId);
            expect(afterSignal.step).toBe("preview_verified");
            expect(afterSignal.previewUrl).toBe("https://preview.example.com");

            const afterPreview = await manager.completePreviewOnboarding(appId, orgId);
            expect(afterPreview.step).toBe("completed");
            expect(afterPreview.completedAt).not.toBeNull();
        });

        test("cannot complete from webhook_configuring step", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "webhook_configuring" },
                update: { step: "webhook_configuring" },
            });
            await expect(manager.complete(appId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot set url from webhook_configuring step", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "webhook_configuring" },
                update: { step: "webhook_configuring" },
            });
            await expect(manager.setUrl(appId, "https://example.com")).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot advance from completed step", async ({ harness, seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await harness.seedScenarioWithRecipe(appId, orgId);
            await linkRepository(harness, appId, 91_002);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "dry_run_passed" },
                update: { step: "dry_run_passed" },
            });
            await manager.complete(appId);
            await manager.completeGithub(appId, orgId);
            await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");
            await manager.acceptDeploymentSignal({
                bodyText: deploymentSignalBody(appId, "https://completed-preview.example.com"),
                signature: deploymentSignalSignature(
                    deploymentSignalBody(appId, "https://completed-preview.example.com"),
                    "shared-secret",
                ),
            });
            await manager.completePreviewOnboarding(appId, orgId);

            // Backwards-compatible operations should succeed from completed step.
            // setUrl moves state to github via loadStateOrEarlier
            await expect(manager.setUrl(appId, "https://x.com")).resolves.toBeDefined();
            // completeGithub moves forward to preview_environment.
            await expect(manager.completeGithub(appId, orgId)).resolves.toBeDefined();
        });

        test("completeGithub requires a linked repository and then advances to preview_environment", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "github" },
                update: { step: "github" },
            });

            await expect(manager.completeGithub(appId, orgId)).rejects.toThrow(
                "Connect a GitHub repository before choosing a preview environment",
            );

            await linkRepository(harness, appId, 91_004);
            const state = await manager.completeGithub(appId, orgId);
            expect(state.step).toBe("preview_environment");
        });

        test("PreviewKit path requires a linked repository", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });

            await expect(manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit")).rejects.toThrow(
                "Connect a GitHub repository before choosing a preview environment",
            );
        });

        test("existing-deploys path requires a linked repository", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });

            await expect(manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys")).rejects.toThrow(
                "Connect a GitHub repository before choosing a preview environment",
            );
        });

        test("triggerPreviewkitMainDeploy calls PreviewKit for main env 0", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_005);
            const previewkitClient = {
                isConfigured: vi.fn(() => true),
                deployApplicationMain: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient,
            });
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");
            await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig(), "user_1");

            const readiness = await manager.triggerPreviewkitMainDeploy(appId, orgId);

            expect(previewkitClient.deployApplicationMain).toHaveBeenCalledWith(appId, orgId);
            expect(readiness.diagnostics.status).toBe("building");
            const state = await manager.getState(appId);
            expect(state.step).toBe("previewkit_deploying");
            expect(state.previewEnvironmentMode).toBe("previewkit");
            expect(state.previewVerificationStatus).toBe("building");
        });

        test("getPreviewReadiness fails a stale PreviewKit deploy request with no environment", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_105);
            const staleDeployRequestedAt = new Date(Date.now() - 3 * 60 * 1000);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                    updatedAt: staleDeployRequestedAt,
                },
                update: {
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                    updatedAt: staleDeployRequestedAt,
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("failed");
            expect(readiness.mode).toBe("previewkit");
            expect(readiness.diagnostics.error).toContain("no environment was created");
            expect(readiness.diagnostics.actions).toEqual(["redeploy", "edit_config", "copy_for_agent"]);
            const state = await manager.getState(appId);
            expect(state.step).toBe("previewkit_deploying");
            expect(state.previewVerificationStatus).toBe("failed");
        });

        test("getPreviewReadiness keeps failed PreviewKit environments failed even when branch is stale", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            const githubRepositoryId = 91_106;
            await linkRepository(harness, appId, githubRepositoryId);
            const branch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: appId, name: "main" },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branch.id },
                data: { lastHandledSha: "new-head-sha" },
            });
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                },
                update: {
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                },
            });
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-failed-${appId}`,
                    repoFullName: "Autonoma-AI/failing-preview",
                    prNumber: 0,
                    headSha: "old-head-sha",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId: orgId,
                    status: "failed",
                    phase: "failed",
                    error: "Build failed before a URL was created",
                    urls: {},
                    manifest: {},
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("failed");
            expect(readiness.diagnostics.phase).toBe("failed");
            expect(readiness.diagnostics.error).toBe("Build failed before a URL was created");
            const state = await manager.getState(appId);
            expect(state.previewVerificationStatus).toBe("failed");
        });

        test("getPreviewReadiness ignores a historical PreviewKit environment before deploy starts", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            const githubRepositoryId = 91_107;
            await linkRepository(harness, appId, githubRepositoryId);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "previewkit_configuring",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "idle",
                },
                update: {
                    step: "previewkit_configuring",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "idle",
                },
            });
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-old-ready-${appId}`,
                    repoFullName: "Autonoma-AI/old-ready-preview",
                    prNumber: 0,
                    headSha: "old-head-sha",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId: orgId,
                    status: "ready",
                    phase: "ready",
                    urls: { web: "https://old-preview.example.com" },
                    manifest: { apps: [{ name: "web", port: 3000, primary: true }], services: [], addons: [] },
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("idle");
            expect(readiness.diagnostics.logs.available).toBe(false);
            expect(readiness.previewUrl).toBeUndefined();
        });

        test("getPreviewReadiness hides stale logs while a new PreviewKit deploy request is pending", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            const githubRepositoryId = 91_108;
            const deployRequestedAt = new Date(Date.now() - 10_000);
            const staleEnvironmentUpdatedAt = new Date(Date.now() - 20_000);
            await linkRepository(harness, appId, githubRepositoryId);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                    updatedAt: deployRequestedAt,
                },
                update: {
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                    updatedAt: deployRequestedAt,
                },
            });
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-stale-ready-${appId}`,
                    repoFullName: "Autonoma-AI/stale-ready-preview",
                    prNumber: 0,
                    headSha: "old-head-sha",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId: orgId,
                    status: "ready",
                    phase: "ready",
                    urls: { web: "https://stale-preview.example.com" },
                    manifest: { apps: [{ name: "web", port: 3000, primary: true }], services: [], addons: [] },
                    updatedAt: staleEnvironmentUpdatedAt,
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("building");
            expect(readiness.diagnostics.phase).toBe("deploy_requested");
            expect(readiness.diagnostics.logs.available).toBe(false);
            expect(readiness.previewUrl).toBeUndefined();
        });

        test("getPreviewReadiness keeps logs for active build activity after deploy request", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            const githubRepositoryId = 91_109;
            const deployRequestedAt = new Date(Date.now() - 10_000);
            const staleEnvironmentUpdatedAt = new Date(deployRequestedAt.getTime() - 10_000);
            const buildStartedAt = new Date(deployRequestedAt.getTime() + 1_000);
            await linkRepository(harness, appId, githubRepositoryId);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                    updatedAt: deployRequestedAt,
                },
                update: {
                    step: "previewkit_deploying",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "building",
                    updatedAt: deployRequestedAt,
                },
            });
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-active-build-${appId}`,
                    repoFullName: "Autonoma-AI/active-build-preview",
                    prNumber: 0,
                    headSha: "new-head-sha",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId: orgId,
                    status: "building",
                    phase: "building-images",
                    urls: {},
                    manifest: { apps: [{ name: "web", port: 3000, primary: true }], services: [], addons: [] },
                    updatedAt: staleEnvironmentUpdatedAt,
                },
            });
            await harness.db.previewkitBuild.create({
                data: {
                    environmentId: environment.id,
                    headSha: "new-head-sha",
                    status: "building",
                    startedAt: buildStartedAt,
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("building");
            expect(readiness.diagnostics.phase).toBe("building-images");
            expect(readiness.diagnostics.logs.available).toBe(true);
            const state = await harness.db.onboardingState.findUniqueOrThrow({ where: { applicationId: appId } });
            expect(state.updatedAt.getTime()).toBe(deployRequestedAt.getTime());
        });

        test("PreviewKit config save validates and activates a dashboard revision", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_006);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            const saved = await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig(), "user_1");

            expect(saved.saved).toBe(true);
            expect(saved.revision).toBe(1);
            const app = await harness.db.application.findUniqueOrThrow({
                where: { id: appId },
                select: { activeConfigRevisionId: true },
            });
            expect(app.activeConfigRevisionId).toBe(saved.revisionId);
            const revision = await harness.db.previewkitConfigRevision.findUniqueOrThrow({
                where: { id: saved.revisionId },
                select: { source: true, createdBy: true },
            });
            expect(revision.source).toBe("dashboard");
            expect(revision.createdBy).toBe("user_1");
        });

        test("triggerPreviewkitMainDeploy requires an active valid config", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_007);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient: {
                    isConfigured: () => true,
                    deployApplicationMain: async () => undefined,
                },
            });
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            await expect(manager.triggerPreviewkitMainDeploy(appId, orgId)).rejects.toThrow(
                "Save a valid PreviewKit config before starting a deploy",
            );
        });

        test("savePreviewkitConfig rejects invalid config", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_008);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");

            await expect(
                manager.savePreviewkitConfig(appId, orgId, { version: 1, apps: [] }, "user_1"),
            ).rejects.toThrow("Invalid PreviewKit config");
        });

        test("PreviewKit secrets are scoped to apps in the active config", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_009);
            const secretsService = {
                list: vi.fn(async () => [{ key: "DATABASE_URL", maskedLength: 16, updatedAt: new Date() }]),
                upsert: vi.fn(async () => undefined),
                delete: vi.fn(async () => true),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
            });
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });
            await manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit");
            await manager.savePreviewkitConfig(
                appId,
                orgId,
                {
                    version: 1,
                    apps: [
                        { name: "web", path: ".", port: 3000, primary: true },
                        { name: "api", path: "./apps/api", port: 4000 },
                    ],
                },
                "user_1",
            );

            await manager.listPreviewkitSecrets(appId, orgId, "api");
            await manager.upsertPreviewkitSecrets(appId, orgId, "api", [{ key: "DATABASE_URL", value: "postgres://" }]);
            await manager.deletePreviewkitSecret(appId, orgId, "api", "DATABASE_URL");

            expect(secretsService.list).toHaveBeenCalledWith(appId, "api", orgId);
            expect(secretsService.upsert).toHaveBeenCalledWith(
                appId,
                "api",
                [{ key: "DATABASE_URL", value: "postgres://" }],
                orgId,
            );
            expect(secretsService.delete).toHaveBeenCalledWith(appId, "api", "DATABASE_URL", orgId);
            await expect(manager.listPreviewkitSecrets(appId, orgId, "worker")).rejects.toThrow(
                "PreviewKit app 'worker' is not defined in the active config",
            );
        });

        test("acceptDeploymentSignal rejects invalid signatures and accepts valid ones", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await harness.db.application.update({
                where: { id: appId },
                data: { signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
            });
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { previewEnvironmentMode: "existing_deploys" },
            });
            const bodyText = deploymentSignalBody(appId, "https://byo-preview.example.com");

            await expect(
                manager.acceptDeploymentSignal({
                    bodyText,
                    signature: "not-valid",
                }),
            ).rejects.toThrow("Invalid signature");

            await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            const state = await manager.getState(appId);
            expect(state.step).toBe("preview_verified");
            expect(state.previewUrl).toBe("https://byo-preview.example.com");
            const app = await harness.db.application.findUniqueOrThrow({
                where: { id: appId },
                select: { mainBranch: { select: { deployment: { select: { webDeployment: true } } } } },
            });
            expect(app.mainBranch?.deployment?.webDeployment?.url).toBe("https://byo-preview.example.com");
        });

        test("acceptDeploymentSignal rejects invalid JSON as a deployment signal body error", async ({
            seedResult: { manager },
        }) => {
            await expect(
                manager.acceptDeploymentSignal({
                    bodyText: "{",
                    signature: "unused",
                }),
            ).rejects.toThrow("Invalid deployment signal body:");
        });

        test("acceptDeploymentSignal rejects invalid payload shape as a deployment signal body error", async ({
            seedResult: { manager },
        }) => {
            await expect(
                manager.acceptDeploymentSignal({
                    bodyText: JSON.stringify({ previewUrl: "not-a-url" }),
                    signature: "unused",
                }),
            ).rejects.toThrow("Invalid deployment signal body:");
        });

        test("acceptDeploymentSignal rejects a valid signal when the app is not in existing_deploys mode", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await harness.db.application.update({
                where: { id: appId },
                data: { signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
            });
            // PreviewKit-mode onboarding: a valid signal must not promote it.
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { previewEnvironmentMode: "previewkit" },
            });
            const bodyText = deploymentSignalBody(appId, "https://byo-preview.example.com");

            await expect(
                manager.acceptDeploymentSignal({
                    bodyText,
                    signature: deploymentSignalSignature(bodyText, "shared-secret"),
                }),
            ).rejects.toThrow("not configured for external deployment signals");

            const state = await manager.getState(appId);
            expect(state.previewUrl).toBeNull();
            expect(state.previewEnvironmentMode).toBe("previewkit");
        });

        test("acceptDeploymentSignal ignores signals for non-main branches", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await harness.db.application.update({
                where: { id: appId },
                data: { signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
            });
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { previewEnvironmentMode: "existing_deploys" },
            });
            const bodyText = JSON.stringify({
                applicationId: appId,
                previewUrl: "https://feature-branch.example.com",
                branch: "feature/not-main",
            });

            const result = await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            expect(result.ignored).toBe(true);
            const state = await manager.getState(appId);
            expect(state.step).not.toBe("preview_verified");
            expect(state.previewUrl).toBeNull();
        });

        test("acceptDeploymentSignal accepts provider commit refs in the branch field", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await harness.db.application.update({
                where: { id: appId },
                data: { signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
            });
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { previewEnvironmentMode: "existing_deploys" },
            });
            const bodyText = JSON.stringify({
                applicationId: appId,
                previewUrl: "https://commit-ref.example.com",
                branch: "bb0445ca9643d114c0a6155a804b04c51db3e990",
                sha: "bb0445ca9643d114c0a6155a804b04c51db3e990",
                provider: "vercel",
            });

            const result = await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            expect(result.ignored).toBe(false);
            const state = await manager.getState(appId);
            expect(state.step).toBe("preview_verified");
            expect(state.previewUrl).toBe("https://commit-ref.example.com");
        });

        test("acceptDeploymentSignal does not roll a completed onboarding back to preview_verified", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await harness.db.application.update({
                where: { id: appId },
                data: { signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
            });
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { previewEnvironmentMode: "existing_deploys", step: "completed", completedAt: new Date() },
            });
            const bodyText = deploymentSignalBody(appId, "https://byo-preview.example.com");

            const result = await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            expect(result.ignored).toBe(false);
            const state = await manager.getState(appId);
            // URL is refreshed, but the step stays completed.
            expect(state.step).toBe("completed");
            expect(state.previewUrl).toBe("https://byo-preview.example.com");
        });

        test("existing-deploys flow advances configuring -> waiting -> preview_verified on signal", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await linkRepository(harness, appId, 91_012);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { step: "preview_environment" },
            });

            await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");
            expect((await manager.getState(appId)).step).toBe("existing_deploys_configuring");

            await manager.confirmExistingDeploysSetup(appId, orgId);
            expect((await manager.getState(appId)).step).toBe("existing_deploys_waiting");

            // Idempotent from the waiting state.
            await manager.confirmExistingDeploysSetup(appId, orgId);
            expect((await manager.getState(appId)).step).toBe("existing_deploys_waiting");

            const bodyText = deploymentSignalBody(appId, "https://byo-preview.example.com");
            await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });
            const state = await manager.getState(appId);
            expect(state.step).toBe("preview_verified");
            expect(state.previewUrl).toBe("https://byo-preview.example.com");
        });

        test("confirmExistingDeploysSetup rejects apps from another organization", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_011);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "existing_deploys_configuring" },
                update: { step: "existing_deploys_configuring" },
            });

            await expect(manager.confirmExistingDeploysSetup(appId, "other-org")).rejects.toThrow(
                "Application not found",
            );

            const state = await manager.getState(appId);
            expect(state.step).toBe("existing_deploys_configuring");
        });

        test("confirmExistingDeploysSetup rejects apps without a linked repository", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "existing_deploys_configuring" },
                update: { step: "existing_deploys_configuring" },
            });

            await expect(manager.confirmExistingDeploysSetup(appId, orgId)).rejects.toThrow(
                "Connect a GitHub repository before choosing a preview environment",
            );

            const state = await manager.getState(appId);
            expect(state.step).toBe("existing_deploys_configuring");
        });

        test("completePreviewOnboarding enqueues generations from preview_verified", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            vi.mocked(triggerRefinementLoop).mockClear();
            const appId = await createApp();
            const branch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: appId, name: "main" },
                select: { id: true },
            });
            const pendingSnapshot = await harness.db.branchSnapshot.create({
                data: {
                    branchId: branch.id,
                    source: "MANUAL",
                    status: "processing",
                },
            });
            await harness.db.branch.update({
                where: { id: branch.id },
                data: { pendingSnapshotId: pendingSnapshot.id },
            });
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "preview_verified",
                    previewEnvironmentMode: "existing_deploys",
                    previewUrl: "https://ready-preview.example.com",
                    previewVerificationStatus: "ready",
                },
                update: {
                    step: "preview_verified",
                    previewEnvironmentMode: "existing_deploys",
                    previewUrl: "https://ready-preview.example.com",
                    previewVerificationStatus: "ready",
                },
            });

            const state = await manager.completePreviewOnboarding(appId, orgId);

            expect(state.step).toBe("completed");
            expect(triggerRefinementLoop).toHaveBeenCalledWith({
                snapshotId: pendingSnapshot.id,
                triggeredBy: "onboarding",
            });
        });

        test("configureAndDiscoverScenarios throws OnboardingApplicationNotFoundError for wrong org", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.seedScenarioWithRecipe(appId, orgId);

            await expect(
                manager.configureAndDiscoverScenarios(
                    appId,
                    "nonexistent-org",
                    "https://webhook.example.com",
                    "secret",
                ),
            ).rejects.toThrow(OnboardingApplicationNotFoundError);
        });

        test("runScenarioDryRun throws InvalidOnboardingStepError from webhook_configuring", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "webhook_configuring" },
                update: { step: "webhook_configuring" },
            });
            await expect(manager.runScenarioDryRun(appId, "some-scenario")).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("DryRunSubject.resolveDeployment throws OnboardingSdkNotConfiguredError when SDK not configured", async ({
            seedResult: { createApp },
            harness,
        }) => {
            const appId = await createApp();
            const subject = new DryRunSubject(harness.db, appId);
            await expect(subject.resolveDeployment()).rejects.toThrow(OnboardingSdkNotConfiguredError);
        });
    },
});

async function linkRepository(harness: OnboardingTestHarness, applicationId: string, githubRepositoryId: number) {
    await harness.db.application.update({
        where: { id: applicationId },
        data: {
            githubRepositoryId,
            signingSecretEnc: fakeEncryption.encrypt("shared-secret"),
        },
    });
}

function deploymentSignalBody(applicationId: string, previewUrl: string): string {
    return JSON.stringify({
        applicationId,
        previewUrl,
        branch: "main",
        sha: "sha",
        provider: "custom",
    });
}

function deploymentSignalSignature(bodyText: string, signingSecret: string): string {
    return createHmac("sha256", signingSecret).update(bodyText).digest("hex");
}

function validPreviewkitConfig() {
    return {
        version: 1,
        apps: [
            {
                name: "web",
                path: ".",
                port: 3000,
                primary: true,
                env: { AUTONOMA_ENABLED: "true" },
                health_check: "/",
            },
        ],
        services: [{ name: "db", recipe: "postgres", version: "16" }],
    };
}
