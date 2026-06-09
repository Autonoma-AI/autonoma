import { integrationTestSuite } from "@autonoma/integration-test";
import type { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { expect } from "vitest";
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
const fakeEncryption = {} as EncryptionHelper;

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

        test("getState auto-migrates legacy install step to webhook_configuring", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.create({ data: { applicationId: appId, step: "install" } });
            const state = await manager.getState(appId);
            expect(state.step).toBe("webhook_configuring");
        });

        test("getState auto-migrates legacy configure step to webhook_configuring", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.create({ data: { applicationId: appId, step: "configure" } });
            const state = await manager.getState(appId);
            expect(state.step).toBe("webhook_configuring");
        });

        test("getState auto-migrates legacy working step to webhook_configuring", async ({
            seedResult: { manager, createApp },
            harness,
        }) => {
            const appId = await createApp();
            await harness.db.onboardingState.create({ data: { applicationId: appId, step: "working" } });
            const state = await manager.getState(appId);
            expect(state.step).toBe("webhook_configuring");
        });

        test("full onboarding flow: webhook_configuring -> dry_run_passed -> github -> completed", async ({
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

            const afterGithub = await manager.completeGithub(appId, orgId);
            expect(afterGithub.step).toBe("completed");
            expect(afterGithub.completedAt).not.toBeNull();
        });

        test("cannot complete from webhook_configuring step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await expect(manager.complete(appId)).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot set url from webhook_configuring step", async ({ seedResult: { manager, createApp } }) => {
            const appId = await createApp();
            await manager.getState(appId);
            await expect(manager.setUrl(appId, "https://example.com")).rejects.toThrow(InvalidOnboardingStepError);
        });

        test("cannot advance from completed step", async ({ harness, seedResult: { orgId, manager, createApp } }) => {
            const appId = await createApp();
            await harness.seedScenarioWithRecipe(appId, orgId);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "dry_run_passed" },
                update: { step: "dry_run_passed" },
            });
            await manager.complete(appId);
            await manager.completeGithub(appId, orgId);

            // Backwards-compatible operations should succeed from completed step.
            // setUrl moves state to github via loadStateOrEarlier
            await expect(manager.setUrl(appId, "https://x.com")).resolves.toBeDefined();
            // completeGithub moves back to completed
            await expect(manager.completeGithub(appId, orgId)).resolves.toBeDefined();
        });

        test("reset from completed returns to webhook_configuring", async ({
            harness,
            seedResult: { orgId, manager, createApp },
        }) => {
            const appId = await createApp();
            await harness.seedScenarioWithRecipe(appId, orgId);
            await harness.db.onboardingState.upsert({
                where: { applicationId: appId },
                create: { applicationId: appId, step: "dry_run_passed" },
                update: { step: "dry_run_passed" },
            });
            await manager.complete(appId, "https://example.com");
            await manager.completeGithub(appId, orgId);

            const afterReset = await manager.reset(appId);
            expect(afterReset.step).toBe("webhook_configuring");
            expect(afterReset.agentConnectedAt).toBeNull();
            expect(afterReset.productionUrl).toBeNull();
            expect(afterReset.completedAt).toBeNull();
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

        test("runScenarioDryRun throws InvalidOnboardingStepError from wrong step", async ({
            seedResult: { manager, createApp },
        }) => {
            const appId = await createApp();
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
