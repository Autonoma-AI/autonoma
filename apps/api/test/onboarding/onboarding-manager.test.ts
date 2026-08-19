import { createHmac } from "node:crypto";
import type { PrismaClient } from "@autonoma/db";
import { NotFoundError } from "@autonoma/errors";
import { integrationTestSuite } from "@autonoma/integration-test";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { DiscoverResponse } from "@autonoma/types";
import { expect, vi } from "vitest";
import { DryRunSubject } from "../../src/routes/onboarding/dry-run-subject";
import { OnboardingManager } from "../../src/routes/onboarding/onboarding-manager";
import {
    InvalidOnboardingStepError,
    OnboardingApplicationNotFoundError,
    OnboardingSdkNotConfiguredError,
} from "../../src/routes/onboarding/states/onboarding-state";
import { OnboardingTestHarness } from "./onboarding-harness";

const fakeScenarioManager = {
    discoverWithConfig: async () => ({ models: [] }),
} as unknown as ScenarioManager;
const fakeEncryption = new EncryptionHelper("0".repeat(64));

/**
 * Seed an application so all four artifacts are "received" (a scenario with an
 * active recipe version + qa-tests/AUTONOMA.md/scenarios.md file events) under a
 * setup with the given currentStep/status, to exercise the artifactsUploaded
 * discriminator (manual upload vs CLI run).
 */
async function seedReceivedArtifacts(
    harness: OnboardingTestHarness,
    appId: string,
    orgId: string,
    setup: { status: string },
): Promise<void> {
    // Recipe received: a scenario with an active recipe version (also creates the
    // snapshot the recipe version needs).
    await harness.seedScenarioWithRecipe(appId, orgId);

    const user = await harness.db.user.create({
        data: { name: "Artifacts User", email: `artifacts-${appId}@example.com` },
    });
    const setupRow = await harness.db.applicationSetup.create({
        data: {
            applicationId: appId,
            organizationId: orgId,
            userId: user.id,
            status: setup.status,
        },
    });
    // tests / kb / scenarios received: file.created events on the setup.
    await harness.db.applicationSetupEvent.createMany({
        data: [
            { setupId: setupRow.id, type: "file.created", data: { filePath: "autonoma/qa-tests/home.md" } },
            { setupId: setupRow.id, type: "file.created", data: { filePath: "AUTONOMA.md" } },
            { setupId: setupRow.id, type: "file.created", data: { filePath: "scenarios.md" } },
        ],
    });
}
const DISCOVER_RESPONSE = {
    schema: {
        models: [{ name: "User", fields: [] }],
        edges: [],
        relations: [],
        scopeField: "organizationId",
    },
};

// Every case shares one organization and the "acme/app" repo, and `previewkit_environment` is unique
// on (repo_full_name, pr_number) - so a PreviewKit-environment fixture must use a PR number no other
// case in this file uses.
integrationTestSuite({
    name: "OnboardingManager",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption);
        return { orgId, manager, createApp: () => harness.createApp(orgId) };
    },
    cases: (test) => {
        test("getState answers with the initial state when no record exists, and writes nothing", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            // Applications created today get this row at creation. Only rows predating that are
            // missing, which is what this drops back to.
            await harness.db.onboardingState.delete({ where: { applicationId: appId } });

            const state = await manager.getState(appId);

            expect(state.step).toBe("github");
            expect(state.agentConnectedAt).toBeNull();
            expect(state.completedAt).toBeNull();
            // A query must not write, so the read leaves the application without a row rather than
            // giving it one.
            expect(await harness.db.onboardingState.findUnique({ where: { applicationId: appId } })).toBeNull();
        });

        test("getState reports a stale in-flight discover capability as stopped, without writing", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            const startedAt = new Date(Date.now() - 3 * 60 * 1000);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { discoveringStartedAt: startedAt },
            });

            const state = await manager.getState(appId);

            // Discover is a capability, not a step: the step is untouched, only the
            // stuck in-flight flag is reported as cleared.
            expect(state.step).toBe("github");
            expect(state.discoveringStartedAt).toBeNull();
            expect(state.discoveryInProgress).toBe(false);
            expect(state.lastDiscoveryError).toBe("Discovery timed out or crashed. Please retry.");

            // Derived in the response, not repaired in the row - the retry mutation is what writes.
            const row = await harness.db.onboardingState.findUniqueOrThrow({ where: { applicationId: appId } });
            expect(row.discoveringStartedAt).toEqual(startedAt);
            expect(row.lastDiscoveryError).toBeNull();
        });

        test("getState keeps a recent in-flight discover capability in progress", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { discoveringStartedAt: new Date(Date.now() - 30 * 1000) },
            });

            const state = await manager.getState(appId);

            expect(state.discoveryInProgress).toBe(true);
            expect(state.lastDiscoveryError).toBeNull();
        });

        test("listSdkDryRunTargets throws for an unknown or unauthorized application", async ({
            seedResult: { manager, orgId },
        }) => {
            await expect(manager.listSdkDryRunTargets("does-not-exist", orgId)).rejects.toThrow(NotFoundError);
        });

        test("full onboarding flow: github -> preview_environment -> preview_verified -> completed", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            await harness.seedScenarioWithRecipe(appId, orgId);

            // Add app: a row starts at github now that SDK + CLI moved out.
            expect((await manager.getState(appId)).step).toBe("github");

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

            // Verifying the preview IS going live - there is no step in between.
            const afterPreview = await manager.completePreviewOnboarding(appId, orgId);
            expect(afterPreview.step).toBe("completed");
            expect(afterPreview.completedAt).not.toBeNull();
        });

        test("cannot go live before the preview is verified", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_021);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "preview_environment" },
                update: { step: "preview_environment" },
            });
            await expect(manager.goLive(appId, orgId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("completeGithub remains callable from a completed onboarding", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.seedScenarioWithRecipe(appId, orgId);
            await linkRepository(harness, appId, 91_002);
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
            await manager.goLive(appId, orgId);

            // Backwards-compatible operation should still succeed from completed.
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

        test("confirming existing-deploys setup is refused until a signal has landed", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_031);
            await manager.completeGithub(appId, orgId);
            await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");

            await expect(manager.confirmExistingDeploysSetup(appId, orgId)).rejects.toThrow(
                "No deployment signal has reached Autonoma yet",
            );
            expect((await manager.getState(appId)).step).toBe("existing_deploys_configuring");
        });

        test("switching preview path is refused once a preview is verified", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_032);
            await manager.completeGithub(appId, orgId);
            await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");
            await manager.acceptDeploymentSignal({
                bodyText: deploymentSignalBody(appId, "https://verified.example.com"),
                signature: deploymentSignalSignature(
                    deploymentSignalBody(appId, "https://verified.example.com"),
                    "shared-secret",
                ),
            });

            await expect(manager.selectPreviewEnvironmentMode(appId, orgId, "previewkit")).rejects.toThrow(
                "already has a verified preview",
            );
            const state = await manager.getState(appId);
            expect(state.previewEnvironmentMode).toBe("existing_deploys");
            expect(state.previewUrl).toBe("https://verified.example.com");
        });

        test("re-selecting the same path preserves the verified preview instead of restarting", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_033);
            await manager.completeGithub(appId, orgId);
            await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");
            await manager.acceptDeploymentSignal({
                bodyText: deploymentSignalBody(appId, "https://same-path.example.com"),
                signature: deploymentSignalSignature(
                    deploymentSignalBody(appId, "https://same-path.example.com"),
                    "shared-secret",
                ),
            });

            const after = await manager.selectPreviewEnvironmentMode(appId, orgId, "existing_deploys");

            expect(after.step).toBe("preview_verified");
            expect(after.previewUrl).toBe("https://same-path.example.com");
        });

        test("triggerPreviewkitMainDeploy calls PreviewKit for main env 0", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_005);
            // The receipt the real client returns: what the deploy actually started, so a caller can
            // hand it back instead of "a deploy was requested".
            const receipt = {
                repoFullName: "acme/web",
                branch: "main",
                headSha: "deadbeef",
                prNumber: 0,
                workflowId: "analysis-run-branch-1",
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => receipt),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
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
            await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig());

            const readiness = await manager.triggerPreviewkitMainDeploy(appId, orgId);

            expect(previewkitClient.deployApplicationMain).toHaveBeenCalledWith(appId, orgId);
            expect(readiness.started).toBe(true);
            expect(readiness.diagnostics.status).toBe("building");
            expect(readiness.started === true ? readiness.queued : undefined).toEqual(receipt);
            const state = await manager.getState(appId);
            expect(state.step).toBe("previewkit_deploying");
            expect(state.previewEnvironmentMode).toBe("previewkit");
            expect(state.previewVerificationStatus).toBe("building");
        });

        test("triggerPreviewkitMainDeploy declines while a deploy is already in flight", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_041);
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => ({
                    repoFullName: "acme/web",
                    branch: "main",
                    headSha: "deadbeef",
                    prNumber: 0,
                })),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
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
            await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig());
            await manager.triggerPreviewkitMainDeploy(appId, orgId);
            previewkitClient.deployApplicationMain.mockClear();

            const declined = await manager.triggerPreviewkitMainDeploy(appId, orgId);

            expect(declined.started).toBe(false);
            expect(declined.started === false ? declined.declined : undefined).toBe("already_in_flight");
            // The whole point: the deploy the caller was waiting on is still the one running.
            expect(previewkitClient.deployApplicationMain).not.toHaveBeenCalled();
            expect(declined.diagnostics.status).toBe("building");
        });

        test("triggerPreviewkitMainDeploy supersedes the in-flight deploy when forced", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_042);
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => ({
                    repoFullName: "acme/web",
                    branch: "main",
                    headSha: "cafebabe",
                    prNumber: 0,
                })),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
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
            await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig());
            await manager.triggerPreviewkitMainDeploy(appId, orgId);
            previewkitClient.deployApplicationMain.mockClear();

            const forced = await manager.triggerPreviewkitMainDeploy(appId, orgId, { force: true });

            expect(forced.started).toBe(true);
            expect(previewkitClient.deployApplicationMain).toHaveBeenCalledWith(appId, orgId);
        });

        test("triggerPreviewkitMainDeploy redeploys after a failed deploy without force", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_043);
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => ({
                    repoFullName: "acme/web",
                    branch: "main",
                    headSha: "f00dface",
                    prNumber: 0,
                })),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
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
            await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig());
            // The state a failed deploy leaves behind. A caller told `failed` is being asked to
            // redeploy, so the in-flight guard must not stand in the way of that.
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: {
                    step: "previewkit_deploying",
                    previewVerificationStatus: "failed",
                    previewVerificationError: "Build failed",
                },
            });

            const retried = await manager.triggerPreviewkitMainDeploy(appId, orgId);

            expect(retried.started).toBe(true);
            expect(previewkitClient.deployApplicationMain).toHaveBeenCalledWith(appId, orgId);
        });

        test("getPreviewReadiness fails a stale PreviewKit deploy request with no environment", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_105);
            const staleDeployRequestedAt = new Date(Date.now() - 20 * 60 * 1000);
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

        test("getPreviewReadiness still explains the failure on the poll after it was recorded", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_151);
            const staleDeployRequestedAt = new Date(Date.now() - 20 * 60 * 1000);
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

            // The first read is the transition that diagnoses the failure; the second is every read
            // after it, when the status it just wrote means the transition can no longer be re-derived.
            await manager.getPreviewReadiness(appId, orgId);
            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("failed");
            expect(readiness.diagnostics.error).toContain("no environment was created");
            expect(readiness.diagnostics.error).not.toContain("No PreviewKit environment row exists yet");
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
            const activeSnapshot = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "WEBHOOK", status: "active", headSha: "new-head-sha" },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branch.id },
                data: { activeSnapshotId: activeSnapshot.id },
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

        test("getPreviewReadiness does not roll a verified app back to previewkit_deploying on a rebuild", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            // A transient rebuild reporting "building" keeps the verification status
            // accurate, but must never demote an app that already reached
            // preview_verified - a previewkit app only re-advances while the
            // onboarding page polls readiness, so a demotion strands it short of
            // completed (and keeps nagging "Continue setup").
            const appId = await createApp();
            const githubRepositoryId = 91_111;
            const deployRequestedAt = new Date(Date.now() - 10_000);
            const buildStartedAt = new Date(deployRequestedAt.getTime() + 1_000);
            await linkRepository(harness, appId, githubRepositoryId);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "preview_verified",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "ready",
                    updatedAt: deployRequestedAt,
                },
                update: {
                    step: "preview_verified",
                    previewEnvironmentMode: "previewkit",
                    previewVerificationStatus: "ready",
                    updatedAt: deployRequestedAt,
                },
            });
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-verified-rebuild-${appId}`,
                    repoFullName: "Autonoma-AI/verified-rebuild-preview",
                    prNumber: 0,
                    headSha: "rebuild-head-sha",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId: orgId,
                    status: "building",
                    phase: "building-images",
                    urls: {},
                    updatedAt: new Date(deployRequestedAt.getTime() - 10_000),
                },
            });
            await harness.db.previewkitBuild.create({
                data: {
                    environmentId: environment.id,
                    headSha: "rebuild-head-sha",
                    status: "building",
                    startedAt: buildStartedAt,
                },
            });

            const readiness = await manager.getPreviewReadiness(appId, orgId);

            expect(readiness.diagnostics.status).toBe("building");
            const state = await harness.db.onboardingState.findUniqueOrThrow({ where: { applicationId: appId } });
            expect(state.step).toBe("preview_verified");
            expect(state.previewVerificationStatus).toBe("building");
        });

        test("PreviewKit config save validates and persists the application's config", async ({
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

            const saved = await manager.savePreviewkitConfig(appId, orgId, validPreviewkitConfig());

            expect(saved.saved).toBe(true);
            const stored = await harness.db.previewkitConfig.findUniqueOrThrow({
                where: { applicationId: appId },
                include: { apps: true },
            });
            expect(stored.apps).not.toHaveLength(0);
        });

        test("triggerPreviewkitMainDeploy requires a saved valid config", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_007);
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient: {
                    deployApplicationMain: async () => undefined,
                    redeploy: async () => undefined,
                    startRunForPullRequest: async () => undefined,
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

            await expect(manager.savePreviewkitConfig(appId, orgId, { version: 2, apps: [] })).rejects.toThrow(
                "Invalid PreviewKit config",
            );
        });

        test("PreviewKit secrets are scoped to apps in the saved config", async ({
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
            await manager.savePreviewkitConfig(appId, orgId, {
                version: 2,
                apps: [
                    { name: "web", repository: "acme/app", path: ".", port: 3000, primary: true },
                    { name: "api", repository: "acme/app", path: "./apps/api", port: 4000 },
                ],
            });

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
                "PreviewKit app 'worker' is not defined in the saved config",
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

        test("acceptDeploymentSignal refuses a deployment that cannot build the stored recipes", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            // The endpoint advertises User only, while the recipe also asks for RefinementLoop - the
            // shape of the break this check exists for: a factory deleted under a recipe that still
            // names the entity. The SDK would reject the whole create graph, so no test could run.
            const manager = new OnboardingManager(
                harness.db,
                new StubScenarioManager(harness.db, ["User"]),
                fakeEncryption,
            );
            await manager.getState(appId);
            const snapshotId = await seedMainBranchRecipe(harness, appId, orgId, ["User", "RefinementLoop"]);
            const bodyText = deploymentSignalBody(appId, "https://drifted.example.com");

            await expect(
                manager.acceptDeploymentSignal({
                    bodyText,
                    signature: deploymentSignalSignature(bodyText, "shared-secret"),
                }),
            ).rejects.toThrow(/no factory for standard: RefinementLoop/);

            // Refused before anything moved: the preview URL is not recorded, so no run is opened
            // against a deployment every test would have failed to provision on.
            const state = await manager.getState(appId);
            expect(state.previewUrl).toBeNull();
            expect(snapshotId).not.toBe("");
        });

        test("acceptDeploymentSignal accepts a deployment that can build every model named", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const manager = new OnboardingManager(
                harness.db,
                new StubScenarioManager(harness.db, ["User", "Organization"]),
                fakeEncryption,
            );
            await manager.getState(appId);
            await seedMainBranchRecipe(harness, appId, orgId, ["User", "Organization"]);
            const bodyText = deploymentSignalBody(appId, "https://healthy.example.com");

            await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            const state = await manager.getState(appId);
            expect(state.previewUrl).toBe("https://healthy.example.com");
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

        // The signal is what advances this path - confirming does not, and is refused
        // outright until one has landed ("confirming existing-deploys setup is refused
        // until a signal has landed" covers that).
        test("existing-deploys flow advances configuring -> preview_verified on signal", async ({
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

        test("verifying the preview activates the pending snapshot and completes onboarding", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
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

            // Verifying the preview completes onboarding AND activates the pending snapshot on
            // main: activation belongs to whichever transition lands `completed`, and with
            // `diff_trigger` retired that is this one.
            const live = await manager.completePreviewOnboarding(appId, orgId);
            expect(live.step).toBe("completed");
            const activated = await harness.db.branch.findFirstOrThrow({
                where: { id: branch.id },
                select: { pendingSnapshotId: true, activeSnapshotId: true },
            });
            expect(activated.activeSnapshotId).toBe(pendingSnapshot.id);
            expect(activated.pendingSnapshotId).toBeNull();
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: pendingSnapshot.id },
                select: { status: true },
            });
            expect(snapshot.status).toBe("active");
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

        test("external signal status reports nothing received before the first signal", async ({
            harness,
            seedResult: { manager, createApp, orgId },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "existing_deploys_configuring",
                    previewEnvironmentMode: "existing_deploys",
                },
                update: { step: "existing_deploys_configuring", previewEnvironmentMode: "existing_deploys" },
            });

            const status = await manager.getExternalSignalStatus(appId, orgId);

            expect(status.previewEnvironmentMode).toBe("existing_deploys");
            expect(status.signalReceived).toBe(false);
            expect(status.previewUrl).toBeUndefined();
            expect(status.prReviewsConfirmed).toBe(false);
        });

        test("external signal status separates a received signal from confirmed PR reviews", async ({
            harness,
            seedResult: { manager, createApp, orgId },
        }) => {
            const appId = await createApp();
            // A main-branch signal landed, but none has ever carried a PR - the state
            // an app sits in when its wiring works yet no pull request is reviewed.
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "preview_verified",
                    previewEnvironmentMode: "existing_deploys",
                    previewUrl: "https://main.example.com",
                },
                update: {
                    step: "preview_verified",
                    previewEnvironmentMode: "existing_deploys",
                    previewUrl: "https://main.example.com",
                },
            });

            const received = await manager.getExternalSignalStatus(appId, orgId);
            expect(received.signalReceived).toBe(true);
            expect(received.previewUrl).toBe("https://main.example.com");
            expect(received.prReviewsConfirmed).toBe(false);

            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { diffTriggerConfirmedAt: new Date() },
            });

            const confirmed = await manager.getExternalSignalStatus(appId, orgId);
            expect(confirmed.prReviewsConfirmed).toBe(true);
            expect(confirmed.prReviewsConfirmedAt).toEqual(expect.any(String));
        });

        test("preview environment mode is readable on its own for the MCP path guard", async ({
            harness,
            seedResult: { manager, createApp, orgId },
        }) => {
            const appId = await createApp();
            // Unset until the user picks, which the guard treats as "not decided yet".
            expect(await manager.getPreviewEnvironmentMode(appId, orgId)).toBeUndefined();

            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, previewEnvironmentMode: "existing_deploys" },
                update: { previewEnvironmentMode: "existing_deploys" },
            });

            expect(await manager.getPreviewEnvironmentMode(appId, orgId)).toBe("existing_deploys");
        });

        test("external signal status refuses an app in another org", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();

            await expect(manager.getExternalSignalStatus(appId, "another-org")).rejects.toThrow(NotFoundError);
        });

        test("deployment signal with a prNumber triggers PR diffs and self-confirms the BYO wiring", async ({
            harness,
            seedResult: { createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_131);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "completed", previewEnvironmentMode: "existing_deploys" },
                update: { step: "completed", previewEnvironmentMode: "existing_deploys" },
            });
            const diffsTrigger = {
                triggerMainDiffs: vi.fn(async () => ({ snapshotId: "main-snap" })),
                triggerPrDiffs: vi.fn(async () => ({ snapshotId: "pr-snap" })),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, { diffsTrigger });
            const bodyText = JSON.stringify({
                applicationId: appId,
                previewUrl: "https://pr-42.example.com",
                branch: "feature/login",
                prNumber: 42,
            });

            const result = await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            expect(result.ignored).toBe(false);
            expect(diffsTrigger.triggerPrDiffs).toHaveBeenCalledWith({
                organizationId: expect.any(String),
                repoId: 91_131,
                prNumber: 42,
                url: "https://pr-42.example.com",
                webhookUrl: "https://pr-42.example.com/api/autonoma",
            });
            expect(diffsTrigger.triggerMainDiffs).not.toHaveBeenCalled();
            const state = await manager.getState(appId);
            expect(state.diffTriggerConfirmedAt).not.toBeNull();
            // The PR preview URL must not clobber the tracked main preview URL.
            expect(state.previewUrl).toBeNull();
        });

        test("a completed main-branch signal keeps the suite fresh by triggering main diffs", async ({
            harness,
            seedResult: { createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_132);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "completed", previewEnvironmentMode: "existing_deploys" },
                update: { step: "completed", previewEnvironmentMode: "existing_deploys" },
            });
            const diffsTrigger = {
                triggerMainDiffs: vi.fn(async () => ({ snapshotId: "main-snap" })),
                triggerPrDiffs: vi.fn(async () => ({ snapshotId: "pr-snap" })),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, { diffsTrigger });
            const bodyText = deploymentSignalBody(appId, "https://main-preview.example.com");

            await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            expect(diffsTrigger.triggerMainDiffs).toHaveBeenCalledWith({
                organizationId: expect.any(String),
                repoId: 91_132,
                url: "https://main-preview.example.com",
                webhookUrl: "https://main-preview.example.com/api/autonoma",
            });
            expect(diffsTrigger.triggerPrDiffs).not.toHaveBeenCalled();
            const state = await manager.getState(appId);
            expect(state.previewUrl).toBe("https://main-preview.example.com");
        });

        test("a main-branch signal during onboarding records the URL without triggering main diffs", async ({
            harness,
            seedResult: { createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 91_133);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: {
                    applicationId: appId,
                    step: "existing_deploys_waiting",
                    previewEnvironmentMode: "existing_deploys",
                },
                update: { step: "existing_deploys_waiting", previewEnvironmentMode: "existing_deploys" },
            });
            const diffsTrigger = {
                triggerMainDiffs: vi.fn(async () => ({ snapshotId: "main-snap" })),
                triggerPrDiffs: vi.fn(async () => ({ snapshotId: "pr-snap" })),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, { diffsTrigger });
            const bodyText = deploymentSignalBody(appId, "https://onboarding-preview.example.com");

            await manager.acceptDeploymentSignal({
                bodyText,
                signature: deploymentSignalSignature(bodyText, "shared-secret"),
            });

            expect(diffsTrigger.triggerMainDiffs).not.toHaveBeenCalled();
            const state = await manager.getState(appId);
            expect(state.step).toBe("preview_verified");
            expect(state.previewUrl).toBe("https://onboarding-preview.example.com");
        });

        test("listSdkDryRunTargets returns the main env and auto-detects the SDK PR", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            // An open PR implementing the SDK, with its own preview deployment.
            const prBranch = await harness.db.branch.create({
                data: {
                    name: "ignacio/feat-autonoma-sdk",
                    applicationId: appId,
                    organizationId: orgId,
                    prInfo: {
                        create: {
                            applicationId: appId,
                            prNumber: 7,
                            prTitle: "feat: autonoma-sdk endpoint",
                            prState: "open",
                        },
                    },
                },
            });
            const prDeployment = await harness.db.branchDeployment.create({
                data: {
                    branchId: prBranch.id,
                    organizationId: orgId,
                    webDeployment: { create: { url: "https://pr-7.example.com", organizationId: orgId } },
                },
            });
            await harness.db.branch.update({
                where: { id: prBranch.id },
                data: { deploymentId: prDeployment.id },
            });

            const result = await manager.listSdkDryRunTargets(appId, orgId);

            const main = result.targets.find((t) => t.kind === "main");
            expect(main?.sdkUrl).toBe("https://placeholder.example.com/api/autonoma");
            expect(main?.source).toBe("external");
            expect(main?.requiresSharedSecretInput).toBe(true);
            const prTarget = result.targets.find((t) => t.id === "pr-7");
            expect(prTarget?.isAutoDetected).toBe(true);
            expect(prTarget?.sdkUrl).toBe("https://pr-7.example.com/api/autonoma");
            expect(prTarget?.source).toBe("external");
            expect(prTarget?.requiresSharedSecretInput).toBe(true);
            expect(result.autoDetectedTargetId).toBe("pr-7");
        });

        test("listSdkDryRunTargets includes managed PreviewKit metadata and uses the primary app URL", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            const repoId = 778_899;
            await harness.db.application.update({ where: { id: appId }, data: { githubRepositoryId: repoId } });
            // A deployed PR preview exists, but the diffs flow has not created a
            // branch/prInfo row for it yet - it must still be selectable.
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-no-branch-${appId}-pr-9`,
                    repoFullName: "acme/app",
                    prNumber: 9,
                    headSha: "sha-9",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    urls: {
                        api: "https://api-pr-9.preview.example.com",
                        web: "https://web-pr-9.preview.example.com",
                    },
                    resolvedConfig: {
                        version: 2,
                        apps: [
                            { name: "api", repository: "acme/app", path: "apps/api", port: 4000 },
                            { name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true },
                        ],
                    },
                },
            });

            const result = await manager.listSdkDryRunTargets(appId, orgId);

            const prTarget = result.targets.find((t) => t.id === "pr-9");
            expect(prTarget?.source).toBe("previewkit");
            expect(prTarget?.environmentId).toBe(environment.id);
            expect(prTarget?.sdkAppName).toBe("web");
            expect(prTarget?.status).toBe("ready");
            expect(prTarget?.requiresSharedSecretInput).toBe(false);
            expect(prTarget?.previewUrl).toBe("https://web-pr-9.preview.example.com");
            expect(prTarget?.sdkUrl).toBe("https://web-pr-9.preview.example.com/api/autonoma");
            // Auto-detected from the env's headRef even without a tracked PR title.
            expect(prTarget?.isAutoDetected).toBe(true);
            expect(prTarget?.label).toBe("feat-autonoma-sdk");
            expect(result.autoDetectedTargetId).toBe("pr-9");
            expect(prTarget?.availability).toBe("ready");
        });

        test("listSdkDryRunTargets lists building, failed, and preview-less PRs with availability states", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            const repoId = 778_900;
            await harness.db.application.update({ where: { id: appId }, data: { githubRepositoryId: repoId } });

            // PR 11: deploy in flight - urls not filled in yet.
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-building-${appId}-pr-11`,
                    repoFullName: "acme/app",
                    prNumber: 11,
                    headSha: "sha-11",
                    headRef: "feat/one",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "building",
                    urls: {},
                },
            });
            // PR 12: deploy failed.
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-failed-${appId}-pr-12`,
                    repoFullName: "acme/app",
                    prNumber: 12,
                    headSha: "sha-12",
                    headRef: "feat/two",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "failed",
                    error: "image build exited with code 1",
                    urls: {},
                },
            });
            // PR 13: open PR tracked by a branch, but no preview env and no deployment.
            await harness.db.branch.create({
                data: {
                    name: "feat/three",
                    applicationId: appId,
                    organizationId: orgId,
                    prInfo: {
                        create: { applicationId: appId, prNumber: 13, prTitle: "feat: three", prState: "open" },
                    },
                },
            });

            const result = await manager.listSdkDryRunTargets(appId, orgId);

            const building = result.targets.find((t) => t.id === "pr-11");
            expect(building?.availability).toBe("building");
            expect(building?.source).toBe("previewkit");
            expect(building?.sdkUrl).toBeUndefined();
            expect(building?.previewUrl).toBeUndefined();
            expect(building?.headRef).toBe("feat/one");
            expect(building?.headSha).toBe("sha-11");

            const failed = result.targets.find((t) => t.id === "pr-12");
            expect(failed?.availability).toBe("failed");
            expect(failed?.error).toBe("image build exited with code 1");
            expect(failed?.sdkUrl).toBeUndefined();

            const noPreview = result.targets.find((t) => t.id === "pr-13");
            expect(noPreview?.availability).toBe("no_preview");
            expect(noPreview?.source).toBe("external");
            expect(noPreview?.sdkUrl).toBeUndefined();
            expect(noPreview?.requiresSharedSecretInput).toBe(false);
        });

        test("redeploySdkDryRunTarget redeploys an existing PreviewKit env and flips it to building", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_920;
            await harness.db.application.update({ where: { id: appId }, data: { githubRepositoryId: repoId } });
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-redeploy-${appId}-pr-41`,
                    repoFullName: "acme/app",
                    prNumber: 41,
                    headSha: "sha-41",
                    headRef: "feat/forty-one",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "failed",
                    error: "image build exited with code 1",
                    urls: {},
                },
            });
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient,
            });

            await manager.redeploySdkDryRunTarget(appId, orgId, "pr-41");

            expect(previewkitClient.redeploy).toHaveBeenCalledWith("acme/app", 41, orgId);
            expect(previewkitClient.startRunForPullRequest).not.toHaveBeenCalled();
            const updated = await harness.db.previewkitEnvironment.findUnique({
                where: { id: environment.id },
                select: { status: true },
            });
            expect(updated?.status).toBe("building");
        });

        test("redeploySdkDryRunTarget first-deploys a preview-less PR via startRunForPullRequest", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_921;
            await harness.db.application.update({ where: { id: appId }, data: { githubRepositoryId: repoId } });
            await harness.db.branch.create({
                data: {
                    name: "feat/forty-two",
                    applicationId: appId,
                    organizationId: orgId,
                    prInfo: {
                        create: { applicationId: appId, prNumber: 42, prTitle: "feat: forty-two", prState: "open" },
                    },
                },
            });
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient,
            });

            await manager.redeploySdkDryRunTarget(appId, orgId, "pr-42");

            expect(previewkitClient.startRunForPullRequest).toHaveBeenCalledWith(orgId, repoId, 42);
            expect(previewkitClient.redeploy).not.toHaveBeenCalled();
        });

        test("redeploySdkDryRunTarget rejects an unknown target", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitClient,
            });

            await expect(manager.redeploySdkDryRunTarget(appId, orgId, "pr-999")).rejects.toThrow(
                /Unknown dry-run target/,
            );
            expect(previewkitClient.redeploy).not.toHaveBeenCalled();
            expect(previewkitClient.startRunForPullRequest).not.toHaveBeenCalled();
        });

        test("listSdkDryRunTargets sorts the auto-detected SDK PR first, then main, then PRs newest-first", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.getState(appId);
            for (const [prNumber, title] of [
                [21, "feat: unrelated work"],
                [22, "feat: autonoma-sdk endpoint"],
                [23, "fix: another thing"],
            ] as const) {
                await harness.db.branch.create({
                    data: {
                        name: `branch-${prNumber}`,
                        applicationId: appId,
                        organizationId: orgId,
                        prInfo: {
                            create: { applicationId: appId, prNumber, prTitle: title, prState: "open" },
                        },
                    },
                });
            }

            const result = await manager.listSdkDryRunTargets(appId, orgId);

            expect(result.autoDetectedTargetId).toBe("pr-22");
            expect(result.targets.map((t) => t.id)).toEqual(["pr-22", "main", "pr-23", "pr-21"]);
        });

        test("configureAndDiscoverSdkTarget validates via discover without touching secrets or redeploying", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_901;
            await linkRepository(harness, appId, repoId);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { lastDiscoveryError: "stale error from a previous attempt" },
            });
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-8`,
                    repoFullName: "acme/app",
                    prNumber: 8,
                    headSha: "sha-8",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    bypassToken: "bypass-token",
                    urls: { web: "https://web-pr-8.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            const secretsService = {
                list: vi.fn(async () => [{ key: "AUTONOMA_SIGNING_SECRET", maskedLength: 32, updatedAt: new Date() }]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });
            const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
                return new Response(JSON.stringify(DISCOVER_RESPONSE), {
                    status: 200,
                    headers: { "content-type": "application/json" },
                });
            });
            vi.stubGlobal("fetch", fetchMock);

            try {
                const result = await manager.configureAndDiscoverSdkTarget(appId, orgId, "pr-8", false);

                expect(result.status).toBe("discovered");
                // Validate only validates - prepareSdkTarget owns secret provisioning,
                // so discover never reads or writes PreviewKit secrets.
                expect(secretsService.upsert).not.toHaveBeenCalled();
                expect(secretsService.list).not.toHaveBeenCalled();
                expect(fetchMock).toHaveBeenCalledTimes(1);
                expect(fetchMock.mock.calls[0]?.[0]).toBe("https://web-pr-8.preview.example.com/api/autonoma");
                expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
                    "x-previewkit-bypass": "bypass-token",
                });

                const application = await harness.db.application.findUniqueOrThrow({
                    where: { id: appId },
                    select: {
                        onboardingState: { select: { lastDiscoveredModels: true, lastDiscoveryError: true } },
                        mainBranch: { select: { deployment: { select: { webhookUrl: true, webhookHeaders: true } } } },
                    },
                });
                expect(application.onboardingState?.lastDiscoveredModels).toBe(1);
                expect(application.onboardingState?.lastDiscoveryError).toBeNull();
                expect(application.mainBranch?.deployment?.webhookUrl).toBe(
                    "https://web-pr-8.preview.example.com/api/autonoma",
                );
                expect(application.mainBranch?.deployment?.webhookHeaders).toMatchObject({
                    "x-previewkit-bypass": "bypass-token",
                });
                expect(previewkitClient.redeploy).not.toHaveBeenCalled();
            } finally {
                vi.unstubAllGlobals();
            }
        });

        test("configureAndDiscoverSdkTarget self-heals a managed 401 by redeploying and returns redeploy_started", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_910;
            await linkRepository(harness, appId, repoId);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { lastDiscoveryError: "stale error from a previous attempt" },
            });
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-21`,
                    repoFullName: "acme/app",
                    prNumber: 21,
                    headSha: "sha-21",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt: new Date(),
                    urls: { web: "https://web-pr-21.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            // The shared secret upsert reports a change - clear drift evidence.
            const secretsService = {
                list: vi.fn(async () => [
                    { key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() },
                    { key: "AUTONOMA_SIGNING_SECRET", maskedLength: 64, updatedAt: new Date() },
                ]),
                upsert: vi.fn(async () => ({ created: false, changed: true })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });
            const fetchMock = vi.fn(
                async () =>
                    new Response(JSON.stringify({ error: "Invalid HMAC signature" }), {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    }),
            );
            vi.stubGlobal("fetch", fetchMock);

            try {
                const result = await manager.configureAndDiscoverSdkTarget(appId, orgId, "pr-21", true);

                expect(result.status).toBe("redeploy_started");
                expect(previewkitClient.redeploy).toHaveBeenCalledWith("acme/app", 21, orgId);
                // The redeploy flips the env off "ready" so the frontend keeps polling
                // instead of racing discover against the still-stale pod.
                const env = await harness.db.previewkitEnvironment.findUniqueOrThrow({
                    where: { id: environment.id },
                    select: { status: true },
                });
                expect(env.status).toBe("building");
                // A self-healing 401 is not a terminal failure: no error is persisted.
                const state = await harness.db.onboardingState.findUniqueOrThrow({
                    where: { applicationId: appId },
                    select: { lastDiscoveryError: true, discoveringStartedAt: true },
                });
                expect(state.lastDiscoveryError).toBeNull();
                expect(state.discoveringStartedAt).toBeNull();
            } finally {
                vi.unstubAllGlobals();
            }
        });

        test("configureAndDiscoverSdkTarget redeploys on a managed 401 even when DB/AWS state looks current", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_911;
            await linkRepository(harness, appId, repoId);
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-22`,
                    repoFullName: "acme/app",
                    prNumber: 22,
                    headSha: "sha-22",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt: new Date(),
                    urls: { web: "https://web-pr-22.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            // DB/AWS look perfectly current: secrets present and unchanged, no
            // previewkit secret row newer than the deploy, deploy recorded, status
            // ready. The running pod can still hold a stale secret it captured at
            // boot, so the 401 itself - not these signals - must drive the redeploy.
            const secretsService = {
                list: vi.fn(async () => [
                    { key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() },
                    { key: "AUTONOMA_SIGNING_SECRET", maskedLength: 64, updatedAt: new Date() },
                ]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });
            const fetchMock = vi.fn(
                async () =>
                    new Response(JSON.stringify({ error: "Invalid HMAC signature" }), {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    }),
            );
            vi.stubGlobal("fetch", fetchMock);

            try {
                const result = await manager.configureAndDiscoverSdkTarget(appId, orgId, "pr-22", true);

                expect(result.status).toBe("redeploy_started");
                expect(previewkitClient.redeploy).toHaveBeenCalledWith("acme/app", 22, orgId);
                const env = await harness.db.previewkitEnvironment.findUniqueOrThrow({
                    where: { id: environment.id },
                    select: { status: true },
                });
                expect(env.status).toBe("building");
                const state = await harness.db.onboardingState.findUniqueOrThrow({
                    where: { applicationId: appId },
                    select: { lastDiscoveryError: true },
                });
                expect(state.lastDiscoveryError).toBeNull();
            } finally {
                vi.unstubAllGlobals();
            }
        });

        test("configureAndDiscoverSdkTarget surfaces a managed 401 as terminal when allowSelfHeal is false", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_913;
            await linkRepository(harness, appId, repoId);
            const environment = await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-24`,
                    repoFullName: "acme/app",
                    prNumber: 24,
                    headSha: "sha-24",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt: new Date(),
                    urls: { web: "https://web-pr-24.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            const secretsService = {
                list: vi.fn(async () => [{ key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() }]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });
            const fetchMock = vi.fn(
                async () =>
                    new Response(JSON.stringify({ error: "Invalid HMAC signature" }), {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    }),
            );
            vi.stubGlobal("fetch", fetchMock);

            try {
                // The single auto-retry passes allowSelfHeal=false, so a surviving
                // 401 must surface terminally rather than redeploy again.
                await expect(manager.configureAndDiscoverSdkTarget(appId, orgId, "pr-24", false)).rejects.toThrow(
                    "SDK returned HTTP 401: Invalid HMAC signature",
                );

                expect(previewkitClient.redeploy).not.toHaveBeenCalled();
                const env = await harness.db.previewkitEnvironment.findUniqueOrThrow({
                    where: { id: environment.id },
                    select: { status: true },
                });
                expect(env.status).toBe("ready");
                const state = await harness.db.onboardingState.findUniqueOrThrow({
                    where: { applicationId: appId },
                    select: { lastDiscoveryError: true },
                });
                expect(state.lastDiscoveryError).toBe("SDK returned HTTP 401: Invalid HMAC signature");
            } finally {
                vi.unstubAllGlobals();
            }
        });

        test("configureAndDiscoverSdkTarget does not self-heal a 401 that is not an HMAC rejection", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_914;
            await linkRepository(harness, appId, repoId);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-25`,
                    repoFullName: "acme/app",
                    prNumber: 25,
                    headSha: "sha-25",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt: new Date(),
                    urls: { web: "https://web-pr-25.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            const secretsService = {
                list: vi.fn(async () => [{ key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() }]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });
            // A 401 from a Gatekeeper/auth wall is not our secret drift - a redeploy
            // would not fix it, so even on the first click it must stay terminal.
            const fetchMock = vi.fn(
                async () =>
                    new Response(JSON.stringify({ error: "Unauthorized" }), {
                        status: 401,
                        headers: { "content-type": "application/json" },
                    }),
            );
            vi.stubGlobal("fetch", fetchMock);

            try {
                await expect(manager.configureAndDiscoverSdkTarget(appId, orgId, "pr-25", true)).rejects.toThrow(
                    "SDK returned HTTP 401: Unauthorized",
                );

                expect(previewkitClient.redeploy).not.toHaveBeenCalled();
                const state = await harness.db.onboardingState.findUniqueOrThrow({
                    where: { applicationId: appId },
                    select: { lastDiscoveryError: true },
                });
                expect(state.lastDiscoveryError).toBe("SDK returned HTTP 401: Unauthorized");
            } finally {
                vi.unstubAllGlobals();
            }
        });

        test("prepareSdkTarget redeploys a ready preview that has a secret bundle but no recorded deploy", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_912;
            await linkRepository(harness, appId, repoId);
            // Ready, but no deployedAt was ever recorded (legacy/edge): we cannot
            // prove the pod booted after the secret landed.
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-23`,
                    repoFullName: "acme/app",
                    prNumber: 23,
                    headSha: "sha-23",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    urls: { web: "https://web-pr-23.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            // A secret bundle exists - so there is something to mount.
            await seedSecret(harness, appId);
            const secretsService = {
                list: vi.fn(async () => [
                    { key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() },
                    { key: "AUTONOMA_SIGNING_SECRET", maskedLength: 64, updatedAt: new Date() },
                ]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });

            const result = await manager.prepareSdkTarget(appId, orgId, "pr-23");

            expect(result.status).toBe("redeploy_started");
            expect(previewkitClient.redeploy).toHaveBeenCalledWith("acme/app", 23, orgId);
        });

        test("prepareSdkTarget generates AUTONOMA_SIGNING_SECRET when missing and redeploys", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_904;
            await linkRepository(harness, appId, repoId);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-31`,
                    repoFullName: "acme/app",
                    prNumber: 31,
                    headSha: "sha-31",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt: new Date(),
                    urls: { web: "https://web-pr-31.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            // Only the shared secret exists; the signing secret must be generated.
            const secretsService = {
                list: vi.fn(async () => [{ key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() }]),
                upsert: vi.fn(
                    async (_applicationId: string, _appName: string, items: { key: string; value: string }[]) => ({
                        created: items.some((item) => item.key === "AUTONOMA_SIGNING_SECRET"),
                        changed: items.some((item) => item.key === "AUTONOMA_SIGNING_SECRET"),
                    }),
                ),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });
            const fetchMock = vi.fn(async () => new Response(JSON.stringify(DISCOVER_RESPONSE), { status: 200 }));
            vi.stubGlobal("fetch", fetchMock);

            try {
                const result = await manager.prepareSdkTarget(appId, orgId, "pr-31");

                expect(result.status).toBe("redeploy_started");
                const signingCall = secretsService.upsert.mock.calls.find((call) =>
                    call[2].some((item) => item.key === "AUTONOMA_SIGNING_SECRET"),
                );
                const generated = signingCall?.[2].find((item) => item.key === "AUTONOMA_SIGNING_SECRET")?.value;
                expect(generated).toMatch(/^[0-9a-f]{64}$/);
                expect(generated).not.toBe("shared-secret");
                expect(previewkitClient.redeploy).toHaveBeenCalledWith("acme/app", 31, orgId);
                // Prepare provisions secrets only - it never discovers.
                expect(fetchMock).not.toHaveBeenCalled();
            } finally {
                vi.unstubAllGlobals();
            }
        });

        test("prepareSdkTarget is a no-op when both managed secrets already exist", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_905;
            await linkRepository(harness, appId, repoId);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-32`,
                    repoFullName: "acme/app",
                    prNumber: 32,
                    headSha: "sha-32",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt: new Date(),
                    urls: { web: "https://web-pr-32.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            // Both secrets already present, and the shared upsert reports no change.
            const secretsService = {
                list: vi.fn(async () => [
                    { key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() },
                    { key: "AUTONOMA_SIGNING_SECRET", maskedLength: 64, updatedAt: new Date() },
                ]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });

            const result = await manager.prepareSdkTarget(appId, orgId, "pr-32");

            expect(result.status).toBe("ready");
            // Only the shared secret is re-asserted; the existing signing secret is left untouched.
            expect(secretsService.upsert).toHaveBeenCalledTimes(1);
            expect(secretsService.upsert).toHaveBeenCalledWith(
                appId,
                "web",
                [{ key: "AUTONOMA_SHARED_SECRET", value: "shared-secret" }],
                orgId,
            );
            expect(previewkitClient.redeploy).not.toHaveBeenCalled();
        });

        test("prepareSdkTarget redeploys a stale preview whose secrets were provisioned after its deploy", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            const repoId = 778_906;
            await linkRepository(harness, appId, repoId);
            // Deployed an hour ago...
            const deployedAt = new Date(Date.now() - 60 * 60 * 1000);
            await harness.db.previewkitEnvironment.create({
                data: {
                    namespace: `preview-managed-${appId}-pr-13`,
                    repoFullName: "acme/app",
                    prNumber: 13,
                    headSha: "sha-13",
                    headRef: "feat-autonoma-sdk",
                    githubRepositoryId: repoId,
                    organizationId: orgId,
                    status: "ready",
                    deployedAt,
                    urls: { web: "https://web-pr-13.preview.example.com" },
                    resolvedConfig: {
                        version: 2,
                        apps: [{ name: "web", repository: "acme/app", path: "apps/web", port: 3000, primary: true }],
                    },
                },
            });
            // ...but the secret is newer than the deploy, so the running pod booted
            // before it and is stale.
            await seedSecret(harness, appId);
            // Both secrets already exist; nothing changes on this prepare call.
            const secretsService = {
                list: vi.fn(async () => [
                    { key: "AUTONOMA_SHARED_SECRET", maskedLength: 32, updatedAt: new Date() },
                    { key: "AUTONOMA_SIGNING_SECRET", maskedLength: 64, updatedAt: new Date() },
                ]),
                upsert: vi.fn(async () => ({ created: false, changed: false })),
                delete: vi.fn(async () => true),
            };
            const previewkitClient = {
                deployApplicationMain: vi.fn(async () => undefined),
                redeploy: vi.fn(async () => undefined),
                startRunForPullRequest: vi.fn(async () => undefined),
            };
            const manager = new OnboardingManager(harness.db, fakeScenarioManager, fakeEncryption, {
                previewkitSecretsService: secretsService,
                previewkitClient,
            });

            const result = await manager.prepareSdkTarget(appId, orgId, "pr-13");

            // Stale-vs-secrets must redeploy even though no secret changed.
            expect(result.status).toBe("redeploy_started");
            expect(previewkitClient.redeploy).toHaveBeenCalledWith("acme/app", 13, orgId);
        });

        test("savePreviewkitConfig fans BOTH managed secrets out to every app with one shared signing value", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 778_903);
            // No secrets exist yet, so a fresh signing secret is minted and both the
            // shared and signing secret must be written to every app bundle.
            const secretsService = {
                list: vi.fn(async () => []),
                getValue: vi.fn(async () => undefined),
                upsert: vi.fn(async () => ({ created: true, changed: true })),
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

            await manager.savePreviewkitConfig(appId, orgId, {
                version: 2,
                apps: [
                    { name: "web", repository: "acme/app", path: "apps/web", port: 3000 },
                    { name: "api", repository: "acme/app", path: "apps/api", port: 4000, primary: true },
                ],
            });

            // Every app - not just the primary - gets both secrets in one upsert, so
            // a handler running in any app verifies/signs correctly and the first
            // deploy mounts both (no signing-secret gap).
            const upsertedApps = secretsService.upsert.mock.calls.map((call) => call[1]);
            expect(new Set(upsertedApps)).toEqual(new Set(["web", "api"]));

            const signingValues = new Set<string>();
            for (const call of secretsService.upsert.mock.calls) {
                const items = call[2];
                const shared = items.find((item) => item.key === "AUTONOMA_SHARED_SECRET")?.value;
                const signing = items.find((item) => item.key === "AUTONOMA_SIGNING_SECRET")?.value;
                expect(shared).toBe("shared-secret");
                expect(signing).toMatch(/^[0-9a-f]{64}$/);
                expect(signing).not.toBe("shared-secret");
                if (signing != null) signingValues.add(signing);
            }
            // The signing secret is one logical value shared across every app.
            expect(signingValues.size).toBe(1);
        });

        test("savePreviewkitConfig reuses the canonical app's existing signing secret across apps", async ({
            harness,
            seedResult: { orgId, createApp },
        }) => {
            const appId = await createApp();
            await linkRepository(harness, appId, 778_931);
            const existingSigning = "a".repeat(64);
            const secretsService = {
                list: vi.fn(async () => []),
                getValue: vi.fn(async (_appId: string, _appName: string, key: string) =>
                    key === "AUTONOMA_SIGNING_SECRET" ? existingSigning : undefined,
                ),
                upsert: vi.fn(async () => ({ created: false, changed: true })),
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

            await manager.savePreviewkitConfig(appId, orgId, {
                version: 2,
                apps: [
                    { name: "web", repository: "acme/app", path: "apps/web", port: 3000 },
                    { name: "api", repository: "acme/app", path: "apps/api", port: 4000, primary: true },
                ],
            });

            // The canonical value is read once and written to every app bundle.
            expect(secretsService.getValue).toHaveBeenCalledWith(appId, "api", "AUTONOMA_SIGNING_SECRET", orgId);
            for (const call of secretsService.upsert.mock.calls) {
                const signing = call[2].find((item) => item.key === "AUTONOMA_SIGNING_SECRET")?.value;
                expect(signing).toBe(existingSigning);
            }
        });

        test("setupComplete derives from sdk + artifacts + dry-run", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            const initial = await manager.getState(appId);
            expect(initial.sdkConfigured).toBe(false);
            expect(initial.dryRunPassed).toBe(false);
            expect(initial.artifactsUploaded).toBe(false);
            expect(initial.setupComplete).toBe(false);

            // SDK validated, and every provisionable scenario has torn down cleanly so the
            // dry run reads as passed - but the CLI run is still going, so the artifacts are
            // not uploaded yet and all three are compulsory.
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { lastDiscoveredAt: new Date() },
            });
            await seedReceivedArtifacts(harness, appId, orgId, { status: "running" });
            const scenario = await harness.db.scenario.findFirstOrThrow({ where: { applicationId: appId } });
            await harness.db.scenarioInstance.create({
                data: { applicationId: appId, organizationId: orgId, scenarioId: scenario.id, status: "DOWN_SUCCESS" },
            });

            const partial = await manager.getState(appId);
            expect(partial.sdkConfigured).toBe(true);
            expect(partial.dryRunPassed).toBe(true);
            expect(partial.artifactsUploaded).toBe(false);
            expect(partial.setupComplete).toBe(false);

            // The run completes with every artifact received -> all three done -> complete.
            await harness.db.applicationSetup.updateMany({
                where: { applicationId: appId },
                data: { status: "completed" },
            });
            const complete = await manager.getState(appId);
            expect(complete.artifactsUploaded).toBe(true);
            expect(complete.setupComplete).toBe(true);
        });

        test("setupComplete is true when the app already has recipes + tests, without the capability steps", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            // A freshly-onboarded app with no content is not yet set up.
            expect((await manager.getState(appId)).setupComplete).toBe(false);

            // Establish content: a scenario (recipe) and a test case.
            await harness.db.scenario.create({
                data: { applicationId: appId, organizationId: orgId, name: "Checkout flow" },
            });
            const folder = await harness.db.folder.create({
                data: { applicationId: appId, organizationId: orgId, name: "Default" },
            });
            await harness.db.testCase.create({
                data: {
                    applicationId: appId,
                    organizationId: orgId,
                    folderId: folder.id,
                    name: "Homepage",
                    slug: "homepage",
                },
            });

            const state = await manager.getState(appId);
            expect(state.hasContent).toBe(true);
            // Operational despite none of the three deepening steps being done.
            expect(state.sdkConfigured).toBe(false);
            expect(state.artifactsUploaded).toBe(false);
            expect(state.dryRunPassed).toBe(false);
            expect(state.setupComplete).toBe(true);
        });

        test("hasContent requires both recipes and tests - test cases alone do not complete setup", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            const folder = await harness.db.folder.create({
                data: { applicationId: appId, organizationId: orgId, name: "Default" },
            });
            await harness.db.testCase.create({
                data: {
                    applicationId: appId,
                    organizationId: orgId,
                    folderId: folder.id,
                    name: "Homepage",
                    slug: "homepage",
                },
            });

            const state = await manager.getState(appId);
            expect(state.hasContent).toBe(false);
            expect(state.setupComplete).toBe(false);
        });

        test("artifactsUploaded stays false while the setup is still running, even with all artifacts received", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await seedReceivedArtifacts(harness, appId, orgId, { status: "running" });

            expect((await manager.getState(appId)).artifactsUploaded).toBe(false);
        });

        // The sidebar reads getNavState and the finish-setup screens read getState. Two reads of the
        // same gate is exactly how they drift, so pin that they agree at every step of the flow.
        test("getNavState agrees with getState as an application works through setup", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            const expectAgreement = async (expected: boolean) => {
                const [state, navState] = await Promise.all([manager.getState(appId), manager.getNavState(appId)]);
                expect(navState.setupComplete).toBe(expected);
                expect(state.setupComplete).toBe(expected);
            };

            await expectAgreement(false);

            // SDK discovered and every provisionable scenario torn down cleanly, but the run has not
            // finished uploading - still incomplete, and both reads must say so.
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { lastDiscoveredAt: new Date() },
            });
            await seedReceivedArtifacts(harness, appId, orgId, { status: "running" });
            const scenario = await harness.db.scenario.findFirstOrThrow({ where: { applicationId: appId } });
            await harness.db.scenarioInstance.create({
                data: { applicationId: appId, organizationId: orgId, scenarioId: scenario.id, status: "DOWN_SUCCESS" },
            });
            await expectAgreement(false);

            await harness.db.applicationSetup.updateMany({
                where: { applicationId: appId },
                data: { status: "completed" },
            });
            await expectAgreement(true);
        });

        test("getNavState agrees with getState on the content-without-a-completed-run route", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.scenario.create({
                data: { applicationId: appId, organizationId: orgId, name: "Nav checkout flow" },
            });
            const folder = await harness.db.folder.create({
                data: { applicationId: appId, organizationId: orgId, name: "Nav default" },
            });
            await harness.db.testCase.create({
                data: {
                    applicationId: appId,
                    organizationId: orgId,
                    folderId: folder.id,
                    name: "Nav homepage",
                    slug: "nav-homepage",
                },
            });

            expect((await manager.getNavState(appId)).setupComplete).toBe(true);
            expect((await manager.getState(appId)).setupComplete).toBe(true);
        });

        test("getNavState reports incomplete for an application with no onboarding row", async ({
            harness,
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.delete({ where: { applicationId: appId } });

            expect((await manager.getNavState(appId)).setupComplete).toBe(false);
            expect(await harness.db.onboardingState.findUnique({ where: { applicationId: appId } })).toBeNull();
        });

        // Both reads render on paths the user is not waiting on a write for, and getNavState runs on
        // every page. `updatedAt` is the tell: any write to the row bumps it.
        test("neither onboarding read writes to the row", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await seedReceivedArtifacts(harness, appId, orgId, { status: "completed" });
            const before = await harness.db.onboardingState.findUniqueOrThrow({ where: { applicationId: appId } });

            await manager.getState(appId);
            await manager.getNavState(appId);

            const after = await harness.db.onboardingState.findUniqueOrThrow({ where: { applicationId: appId } });
            expect(after.updatedAt).toEqual(before.updatedAt);
        });

        test("artifactsUploaded is true once the setup is marked completed", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await seedReceivedArtifacts(harness, appId, orgId, { status: "completed" });

            expect((await manager.getState(appId)).artifactsUploaded).toBe(true);
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
    // The name the fixtures' apps carry as `repository`. There is no fake GitHub
    // service in these tests, so config saves resolve the primary repo through
    // the PreviewkitEnvironment fallback - seed one row naming it.
    await harness.db.previewkitEnvironment.create({
        data: {
            namespace: `preview-acme-app-pr-${githubRepositoryId}`,
            repoFullName: "acme/app",
            prNumber: githubRepositoryId,
            headSha: "seed000",
            headRef: "main",
            githubRepositoryId,
            organizationId: (
                await harness.db.application.findUniqueOrThrow({
                    where: { id: applicationId },
                    select: { organizationId: true },
                })
            ).organizationId,
        },
    });
}

/**
 * One stored secret for the app's `web` bundle. Only its existence and timestamp
 * matter here - the SDK-target checks never open it - so the envelope is a
 * placeholder rather than a real seal.
 */
async function seedSecret(harness: OnboardingTestHarness, applicationId: string) {
    await harness.db.previewkitEncryptionKey.upsert({
        where: { id: "test-key" },
        create: { id: "test-key", wrap: Buffer.from("wrapped"), primary: true },
        update: {},
    });
    const webAppId = (await harness.seedTopology(applicationId, ["web"])).get("web")!;
    await harness.db.previewkitSecret.create({
        data: {
            appId: webAppId,
            key: "AUTONOMA_SHARED_SECRET",
            envelope: "v2.test-key.placeholder",
            encryptionKeyId: "test-key",
            fingerprint: "fingerprint",
            maskedLength: 32,
        },
    });
}

/**
 * A ScenarioManager whose discover answers with a fixed model list. Subclassed rather than faked with a
 * cast so the discover signature is checked against the real one - a stub that drifts out of shape is
 * exactly how a test keeps passing while the code it stands in for stops working.
 */
class StubScenarioManager extends ScenarioManager {
    constructor(
        db: PrismaClient,
        private readonly modelNames: string[],
    ) {
        super(db, fakeEncryption);
    }

    public override async discover(): Promise<DiscoverResponse> {
        return {
            schema: {
                models: this.modelNames.map((name) => ({ name, fields: [] })),
                edges: [],
                relations: [],
                scopeField: "organizationId",
            },
        };
    }
}

/**
 * Put a recipe naming `modelNames` on the app's main-branch active snapshot, with a deployment for the
 * signal check to borrow SDK config from. Returns the snapshot id the recipe is pinned to.
 */
async function seedMainBranchRecipe(
    harness: OnboardingTestHarness,
    applicationId: string,
    organizationId: string,
    modelNames: string[],
): Promise<string> {
    await harness.db.application.update({
        where: { id: applicationId },
        data: { signingSecretEnc: fakeEncryption.encrypt("shared-secret") },
    });
    await harness.db.onboardingState.update({
        where: { applicationId },
        data: { previewEnvironmentMode: "existing_deploys" },
    });

    const app = await harness.db.application.findUniqueOrThrow({
        where: { id: applicationId },
        select: { mainBranchId: true },
    });
    const branchId = app.mainBranchId;
    if (branchId == null) throw new Error(`Application ${applicationId} has no main branch`);

    const deployment = await harness.db.branchDeployment.create({
        data: { branchId, organizationId, webhookUrl: "https://sdk.example.com/api/autonoma", active: true },
    });
    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "MANUAL", status: "active", headSha: "recipe-head", baseSha: "recipe-base" },
    });
    await harness.db.branch.update({
        where: { id: branchId },
        data: { activeSnapshotId: snapshot.id, deploymentId: deployment.id },
    });

    const schemaSnapshot = await harness.db.scenarioSchemaSnapshot.create({
        data: { applicationId, snapshotId: snapshot.id, structureJson: { models: {} }, fingerprint: "fp-structure" },
    });
    const scenario = await harness.db.scenario.create({
        data: { applicationId, organizationId, name: "standard", description: "seeded" },
    });
    await harness.db.scenarioRecipeVersion.create({
        data: {
            scenarioId: scenario.id,
            snapshotId: snapshot.id,
            schemaSnapshotId: schemaSnapshot.id,
            applicationId,
            organizationId,
            scenarioNameSnapshot: "standard",
            description: "seeded",
            fingerprint: "fp-recipe",
            validationStatus: "validated",
            validationMethod: "checkScenario",
            validationPhase: "ok",
            fixtureJson: {
                name: "standard",
                description: "seeded",
                create: Object.fromEntries(modelNames.map((name) => [name, [{ _alias: `${name}_1` }]])),
                validation: { status: "validated", method: "checkScenario", phase: "ok" },
            },
        },
    });

    return snapshot.id;
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
        version: 2,
        apps: [
            {
                name: "web",
                repository: "acme/app",
                path: ".",
                port: 3000,
                primary: true,
                health_check: "/",
            },
        ],
        services: [{ name: "db", recipe: "postgres", version: "16" }],
    };
}
