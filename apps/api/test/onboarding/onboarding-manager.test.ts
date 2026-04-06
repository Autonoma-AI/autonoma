import { integrationTestSuite } from "@autonoma/integration-test";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { FakeGenerationProvider } from "@autonoma/test-updates";
import { expect } from "vitest";
import { DryRunSubject } from "../../src/routes/onboarding/dry-run-subject";
import { OnboardingManager } from "../../src/routes/onboarding/onboarding-manager";
import {
    DryRunSubjectMisuseError,
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

        test("full onboarding flow: install -> configure -> working -> scenario_dry_run -> url -> completed", async ({
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();

            const afterConfigure = await manager.startConfigure(appId);
            expect(afterConfigure.step).toBe("configure");

            const afterConnected = await manager.markAgentConnected(appId);
            expect(afterConnected.step).toBe("working");
            expect(afterConnected.agentConnectedAt).not.toBeNull();

            const afterDryRun = await manager.startScenarioDryRun(appId);
            expect(afterDryRun.step).toBe("scenario_dry_run");

            const afterComplete = await manager.complete(appId);
            expect(afterComplete.step).toBe("url");

            const afterUrl = await manager.setUrl(appId, orgId, "https://example.com");
            expect(afterUrl.step).toBe("completed");
            expect(afterUrl.productionUrl).toBe("https://example.com");
            expect(afterUrl.completedAt).not.toBeNull();
        });

        test("cannot mark agent connected from install step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await expect(manager.markAgentConnected(appId)).rejects.toThrow(InvalidOnboardingStepError);
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

        test("cannot set url from scenario dry run step - must go through complete first", async ({
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.startScenarioDryRun(appId);
            await expect(manager.setUrl(appId, orgId, "https://example.com")).rejects.toThrow(
                InvalidOnboardingStepError,
            );
        });

        test("cannot advance from completed step", async ({ seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.startScenarioDryRun(appId);
            await manager.complete(appId);
            await manager.setUrl(appId, orgId, "https://example.com");

            await expect(manager.startConfigure(appId)).rejects.toThrow(InvalidOnboardingStepError);
            await expect(manager.markAgentConnected(appId)).rejects.toThrow(InvalidOnboardingStepError);
            await expect(manager.startScenarioDryRun(appId)).rejects.toThrow(InvalidOnboardingStepError);
            await expect(manager.setUrl(appId, orgId, "https://x.com")).rejects.toThrow(InvalidOnboardingStepError);
            await expect(manager.complete(appId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot set url from working step", async ({ seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await expect(manager.setUrl(appId, orgId, "https://example.com")).rejects.toThrow(
                InvalidOnboardingStepError,
            );
        });

        test("reset from completed returns to install", async ({ seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.startScenarioDryRun(appId);
            await manager.complete(appId);
            await manager.setUrl(appId, orgId, "https://example.com");

            const afterReset = await manager.reset(appId);
            expect(afterReset.step).toBe("install");
            expect(afterReset.agentConnectedAt).toBeNull();
            expect(afterReset.productionUrl).toBeNull();
            expect(afterReset.completedAt).toBeNull();
        });

        test("reset from url returns to install", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.startScenarioDryRun(appId);
            await manager.complete(appId);

            const afterReset = await manager.reset(appId);
            expect(afterReset.step).toBe("install");
        });

        test("reset from working returns to install", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);

            const afterReset = await manager.reset(appId);
            expect(afterReset.step).toBe("install");
            expect(afterReset.agentConnectedAt).toBeNull();
        });

        test("can complete full flow after reset", async ({ seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.reset(appId);

            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
            await manager.startScenarioDryRun(appId);
            await manager.complete(appId);
            const final = await manager.setUrl(appId, orgId, "https://example.com");
            expect(final.step).toBe("completed");
        });

        test("configureAndDiscoverScenarios throws OnboardingApplicationNotFoundError for wrong org", async ({
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
            await manager.startConfigure(appId);
            await manager.markAgentConnected(appId);
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

        test("DryRunSubject.getScenarioId throws DryRunSubjectMisuseError", async ({ harness }) => {
            const subject = new DryRunSubject(harness.db, "any-app-id");
            await expect(subject.getScenarioId()).rejects.toThrow(DryRunSubjectMisuseError);
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
