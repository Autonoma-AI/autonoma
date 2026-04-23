import { integrationTestSuite } from "@autonoma/integration-test";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { FakeGenerationProvider } from "@autonoma/test-updates";
import { expect } from "vitest";
import { DryRunSubject } from "../../src/routes/onboarding/dry-run-subject";
import { OnboardingManager } from "../../src/routes/onboarding/onboarding-manager";
import {
    InvalidOnboardingStepError,
    OnboardingApplicationNotFoundError,
    OnboardingWebhookNotConfiguredError,
} from "../../src/routes/onboarding/states/onboarding-state";
import { OnboardingTestHarness } from "./onboarding-harness";

const fakeScenarioManager = {} as ScenarioManager;
const fakeEncryption = {} as EncryptionHelper;

integrationTestSuite({
    name: "OnboardingManager",
    createHarness: () => OnboardingTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const manager = new OnboardingManager(
            harness.db,
            new FakeGenerationProvider(),
            fakeScenarioManager,
            fakeEncryption,
        );
        return { orgId, manager, createApp: () => harness.createApp(orgId) };
    },
    cases: (test) => {
        test("getState upserts if no record exists", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            const state = await manager.getState(appId);
            expect(state.step).toBe("install");
            expect(state.agentConnectedAt).toBeNull();
            expect(state.completedAt).toBeNull();
        });

        test("full onboarding flow: install -> configure -> working -> webhook_configuring -> github -> completed", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            const afterConfigure = await manager.startConfigure(appId);
            expect(afterConfigure.step).toBe("configure");

            const afterConnected = await manager.markAgentConnected(appId);
            expect(afterConnected.step).toBe("working");
            expect(afterConnected.agentConnectedAt).not.toBeNull();

            await harness.seedScenarioWithRecipe(appId, orgId);
            const afterDryRun = await manager.startScenarioDryRun(appId);
            expect(afterDryRun.step).toBe("webhook_configuring");

            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { step: "dry_run_passed" },
            });
            const afterComplete = await manager.complete(appId, "https://example.com");
            expect(afterComplete.step).toBe("github");
            expect(afterComplete.productionUrl).toBe("https://example.com");

            const afterGithub = await manager.completeGithub(appId, orgId);
            expect(afterGithub.step).toBe("completed");
            expect(afterGithub.completedAt).not.toBeNull();
        });

        test("markAgentConnected from install skips configure", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.getState(appId);
            const afterConnected = await manager.markAgentConnected(appId);
            expect(afterConnected.step).toBe("working");
            expect(afterConnected.agentConnectedAt).not.toBeNull();
        });

        test("cannot start scenario dry run from install step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await expect(manager.startScenarioDryRun(appId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot complete from install step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await expect(manager.complete(appId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot start scenario dry run from configure step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await expect(manager.startScenarioDryRun(appId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot set url from webhook_configuring step - must go through complete first", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await harness.seedScenarioWithRecipe(appId, orgId);
            await manager.startScenarioDryRun(appId);
            await expect(manager.setUrl(appId, "https://example.com")).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot advance from completed step", async ({ harness, seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await harness.seedScenarioWithRecipe(appId, orgId);
            await manager.startScenarioDryRun(appId);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { step: "dry_run_passed" },
            });
            await manager.complete(appId);
            await manager.completeGithub(appId, orgId);

            // Forward-only operations should reject from completed step
            await expect(manager.startConfigure(appId)).rejects.toThrow(InvalidOnboardingStepError);
            await expect(manager.markAgentConnected(appId)).rejects.toThrow(InvalidOnboardingStepError);
            await expect(manager.startScenarioDryRun(appId)).rejects.toThrow(InvalidOnboardingStepError);

            // Backwards-compatible operations should succeed from completed step.
            // setUrl moves state to github via loadStateOrEarlier
            await expect(manager.setUrl(appId, "https://x.com")).resolves.toBeDefined();
            // completeGithub moves back to completed
            await expect(manager.completeGithub(appId, orgId)).resolves.toBeDefined();
        });

        test("cannot set url from working step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await expect(manager.setUrl(appId, "https://example.com")).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("reset from completed returns to install", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await harness.seedScenarioWithRecipe(appId, orgId);
            await manager.startScenarioDryRun(appId);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { step: "dry_run_passed" },
            });
            await manager.complete(appId, "https://example.com");
            await manager.completeGithub(appId, orgId);

            const afterReset = await manager.reset(appId);
            expect(afterReset.step).toBe("install");
            expect(afterReset.agentConnectedAt).toBeNull();
            expect(afterReset.productionUrl).toBeNull();
            expect(afterReset.completedAt).toBeNull();
        });

        test("reset from working returns to install", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);

            const afterReset = await manager.reset(appId);
            expect(afterReset.step).toBe("install");
            expect(afterReset.agentConnectedAt).toBeNull();
        });

        test("can complete full flow after reset", async ({ harness, seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.reset(appId);

            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await harness.seedScenarioWithRecipe(appId, orgId);
            await manager.startScenarioDryRun(appId);
            await harness.db.onboardingState.update({
                where: { applicationId: appId },
                data: { step: "dry_run_passed" },
            });
            await manager.complete(appId, "https://example.com");
            const final = await manager.completeGithub(appId, orgId);
            expect(final.step).toBe("completed");
        });

        test("configureAndDiscoverScenarios throws OnboardingApplicationNotFoundError for wrong org", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await harness.seedScenarioWithRecipe(appId, orgId);
            await manager.startScenarioDryRun(appId);

            await expect(
                manager.configureAndDiscoverScenarios(
                    appId,
                    "nonexistent-org",
                    "https://webhook.example.com",
                    "secret",
                ),
            ).rejects.toThrow(OnboardingApplicationNotFoundError);
        });

        test("configureAndDiscoverScenarios throws InvalidOnboardingStepError from wrong step", async ({
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await expect(
                manager.configureAndDiscoverScenarios(appId, orgId, "https://webhook.example.com", "secret"),
            ).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("runScenarioDryRun throws InvalidOnboardingStepError from wrong step", async ({
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await expect(manager.runScenarioDryRun(appId, "some-scenario")).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("DryRunSubject.getApplicationData throws OnboardingWebhookNotConfiguredError when no webhook", async ({
            seedResult: { createApp },
            harness,
        }) => {
            const appId = await createApp();
            const subject = new DryRunSubject(harness.db, appId);
            await expect(subject.getApplicationData()).rejects.toThrow(OnboardingWebhookNotConfiguredError);
        });
    },
});
