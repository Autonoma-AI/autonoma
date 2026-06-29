import { ApplicationArchitecture } from "@autonoma/db";
import { ScenarioRecipeStore } from "@autonoma/scenario";
import { TOTAL_SETUP_STEPS } from "@autonoma/types";
import { expect, vi } from "vitest";
import { ApplicationSetupService } from "../../src/application-setup/application-setup.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

async function createSetupFixture(harness: APITestHarness, name: string) {
    const app = await harness.services.applications.createApplication({
        name,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });

    // Mirror production wiring: the HTTP router hands the service the real
    // OnboardingManager (not the OnboardingService wrapper), so generation
    // enqueue on setup completion resolves to a real method.
    const onboardingManager = harness.services.onboarding.manager;
    const service = new ApplicationSetupService(
        harness.db,
        harness.generationProvider,
        onboardingManager,
        new ScenarioRecipeStore(harness.db),
    );
    const { id: setupId } = await service.createSetup(harness.userId, harness.organizationId, app.id, app.name);

    return { app, setupId, service, onboardingManager };
}

apiTestSuite({
    name: "application-setup-service",
    cases: (test) => {
        test("createSetup creates a setup record with totalSteps", async ({ harness }) => {
            const app = await harness.services.applications.createApplication({
                name: "Onboarding Progress Test",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/file.png",
            });

            const service = new ApplicationSetupService(
                harness.db,
                harness.generationProvider,
                harness.services.onboarding,
                new ScenarioRecipeStore(harness.db),
            );

            await service.createSetup(harness.userId, harness.organizationId, app.id, app.name);

            const setup = await harness.db.applicationSetup.findFirstOrThrow({
                where: { applicationId: app.id },
                select: { totalSteps: true, status: true },
            });
            expect(setup.totalSteps).toBe(TOTAL_SETUP_STEPS);
            expect(setup.status).toBe("running");
        });

        test("final step completion marks setup complete and advances onboarding", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Application Setup Final Step");

            await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
                version: 1,
                source: {
                    discoverPath: "autonoma/discover.json",
                    scenariosPath: "autonoma/scenarios.md",
                },
                validationMode: "sdk-check",
                recipes: [
                    {
                        name: "standard",
                        description: "standard",
                        create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                ],
            });

            await service.addEvent(setupId, harness.organizationId, {
                type: "step.started",
                data: { step: TOTAL_SETUP_STEPS - 1, name: "Scenario Validation" },
            });
            await service.addEvent(setupId, harness.organizationId, {
                type: "step.completed",
                data: { step: TOTAL_SETUP_STEPS - 1, name: "Scenario Validation" },
            });

            const setup = await harness.db.applicationSetup.findUniqueOrThrow({
                where: { id: setupId },
                select: { status: true, currentStep: true, completedAt: true },
            });
            const onboarding = await harness.db.onboardingState.findUniqueOrThrow({
                where: { applicationId: app.id },
                select: { step: true },
            });

            expect(setup.currentStep).toBe(TOTAL_SETUP_STEPS - 1);
            expect(setup.status).toBe("completed");
            expect(setup.completedAt).not.toBeNull();
            expect(onboarding.step).toBe("github");
        });

        test("PATCH completion enqueues generations once the app is live", async ({ harness }) => {
            // The admin manual upload (and any CLI that finalizes over PATCH) marks
            // the setup completed via updateSetup. Finish setup runs after go-live,
            // so the artifacts it just uploaded leave pending generations that only
            // get drained if completion here triggers the refinement loop.
            const { app, setupId, service, onboardingManager } = await createSetupFixture(
                harness,
                "Application Setup PATCH Live",
            );
            await harness.db.onboardingState.upsert({
                where: { applicationId: app.id },
                create: { applicationId: app.id, step: "completed" },
                update: { step: "completed" },
            });

            const enqueueSpy = vi.spyOn(onboardingManager, "enqueueGenerations").mockResolvedValue(undefined);

            await service.updateSetup(setupId, harness.organizationId, { status: "completed" });

            expect(enqueueSpy).toHaveBeenCalledWith(app.id, harness.organizationId);
            enqueueSpy.mockRestore();
        });

        test("PATCH completion defers generation enqueue while onboarding is unfinished", async ({ harness }) => {
            const { app, setupId, service, onboardingManager } = await createSetupFixture(
                harness,
                "Application Setup PATCH Not Live",
            );
            await harness.db.onboardingState.upsert({
                where: { applicationId: app.id },
                create: { applicationId: app.id, step: "github" },
                update: { step: "github" },
            });

            const enqueueSpy = vi.spyOn(onboardingManager, "enqueueGenerations").mockResolvedValue(undefined);

            await service.updateSetup(setupId, harness.organizationId, { status: "completed" });

            expect(enqueueSpy).not.toHaveBeenCalled();
            enqueueSpy.mockRestore();
        });

        test("partial_failure update marks setup without completion timestamp", async ({ harness }) => {
            const { setupId, service } = await createSetupFixture(harness, "Application Setup Partial Failure");

            await service.updateSetup(setupId, harness.organizationId, {
                status: "partial_failure",
                errorMessage: "Scenario validation failed during recipe preflight",
            });

            const setup = await harness.db.applicationSetup.findUniqueOrThrow({
                where: { id: setupId },
                select: { status: true, completedAt: true, errorMessage: true },
            });

            expect(setup.status).toBe("partial_failure");
            expect(setup.completedAt).toBeNull();
            expect(setup.errorMessage).toBe("Scenario validation failed during recipe preflight");
        });

        test("error event still marks setup failed", async ({ harness }) => {
            const { setupId, service } = await createSetupFixture(harness, "Application Setup Error Event");

            await service.addEvent(setupId, harness.organizationId, {
                type: "error",
                data: { message: "SDK integration failed" },
            });

            const setup = await harness.db.applicationSetup.findUniqueOrThrow({
                where: { id: setupId },
                select: { status: true, errorMessage: true, completedAt: true },
            });

            expect(setup.status).toBe("failed");
            expect(setup.errorMessage).toBe("SDK integration failed");
            expect(setup.completedAt).toBeNull();
        });

        test("uploadArtifacts emits file events for non-recipe artifacts", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Application Setup Artifacts");

            await service.uploadArtifacts(setupId, harness.organizationId, {
                artifacts: [
                    {
                        name: "discover.json",
                        folder: "autonoma",
                        content: JSON.stringify({
                            schema: { models: [], edges: [], relations: [], scopeField: "organizationId" },
                        }),
                    },
                ],
            });

            const events = await harness.db.applicationSetupEvent.findMany({
                where: { setupId, type: "file.created" },
                orderBy: { createdAt: "asc" },
            });
            expect(events.map((event) => (event.data as { filePath?: string }).filePath)).toContain(
                "autonoma/discover.json",
            );

            const scenarios = await harness.db.scenario.findMany({
                where: { applicationId: app.id, isDisabled: false },
            });
            expect(scenarios).toHaveLength(0);
        });

        test("uploadArtifacts records the commit sha on the pending snapshot", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Application Setup Commit Sha");
            const sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

            await service.uploadArtifacts(setupId, harness.organizationId, {
                testCases: [{ name: "login.md", folder: "auth", content: "---\n---\n\nNavigate to /login" }],
                commitSha: sha,
            });

            const branch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: app.id },
                select: { pendingSnapshotId: true },
            });

            const pendingSnapshotId = branch.pendingSnapshotId;
            expect(pendingSnapshotId).not.toBeNull();
            if (pendingSnapshotId == null) throw new Error("expected a pending snapshot");

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: pendingSnapshotId },
                select: { headSha: true },
            });
            expect(snapshot.headSha).toBe(sha);
        });

        test("uploadArtifacts rejects scenario recipes in the generic artifact endpoint", async ({ harness }) => {
            const { setupId, service } = await createSetupFixture(harness, "Application Setup Reject Scenario Recipes");

            await expect(
                service.uploadArtifacts(setupId, harness.organizationId, {
                    artifacts: [
                        {
                            name: "scenario-recipes.json",
                            folder: "autonoma",
                            content: JSON.stringify({
                                version: 1,
                                source: {
                                    discoverPath: "autonoma/discover.json",
                                    scenariosPath: "autonoma/scenarios.md",
                                },
                                validationMode: "sdk-check",
                                recipes: [
                                    {
                                        name: "standard",
                                        description: "standard",
                                        create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
                                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                                    },
                                ],
                            }),
                        },
                    ],
                }),
            ).rejects.toThrow("SCENARIO_RECIPES_MUST_USE_VERSIONED_ENDPOINT");
        });

        test("uploadScenarioRecipeVersions stores fixture JSON and snapshot-scoped schema data", async ({
            harness,
        }) => {
            const { app, setupId, service } = await createSetupFixture(
                harness,
                "Application Setup Scenario Recipe Versions",
            );

            const result = await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
                version: 1,
                source: {
                    discoverPath: "autonoma/discover.json",
                    scenariosPath: "autonoma/scenarios.md",
                },
                validationMode: "sdk-check",
                recipes: [
                    {
                        name: "standard",
                        description: "standard",
                        create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                ],
            });

            expect(result.ok).toBe(true);
            expect(result.scenarioCount).toBe(1);

            const scenarios = await harness.db.scenario.findMany({
                where: { applicationId: app.id, isDisabled: false },
                select: {
                    id: true,
                    name: true,
                    activeRecipeVersionId: true,
                    lastSeenFingerprint: true,
                },
            });
            const activeSnapshotId = (
                await harness.db.application.findUniqueOrThrow({
                    where: { id: app.id },
                    select: {
                        mainBranch: {
                            select: {
                                activeSnapshotId: true,
                            },
                        },
                    },
                })
            ).mainBranch?.activeSnapshotId;
            const schemaSnapshots = await harness.db.scenarioSchemaSnapshot.findMany({
                where: { applicationId: app.id },
                select: { snapshotId: true, structureJson: true },
            });
            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { applicationId: app.id },
                select: { fixtureJson: true, fingerprint: true, schemaSnapshotId: true, snapshotId: true },
            });

            expect(scenarios).toHaveLength(1);
            expect(scenarios[0]?.name).toBe("standard");
            expect(scenarios[0]?.activeRecipeVersionId).toBeTruthy();
            expect(scenarios[0]?.lastSeenFingerprint).toBeTruthy();
            expect(activeSnapshotId).toBeTruthy();
            expect(schemaSnapshots).toHaveLength(1);
            expect(schemaSnapshots[0]?.snapshotId).toBe(activeSnapshotId);
            expect(recipeVersions).toHaveLength(1);
            expect(recipeVersions[0]?.fingerprint).toBeTruthy();
            expect(recipeVersions[0]?.schemaSnapshotId).toBeTruthy();
            expect(recipeVersions[0]?.snapshotId).toBe(activeSnapshotId);

            const recipe = recipeVersions[0]?.fixtureJson as any;
            expect(recipe.name).toBe("standard");
            expect(recipe.description).toBe("standard");
            expect(recipe.create).toEqual({ Organization: [{ _alias: "org1", name: "Acme Corp" }] });
            expect(recipe.validation).toEqual({ status: "validated", method: "checkScenario", phase: "ok" });
        });

        test("uploading tests before recipes links scenarioId after recipe ingestion", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Upload Order Test");

            await service.uploadArtifacts(setupId, harness.organizationId, {
                testCases: [
                    {
                        name: "login-test.md",
                        folder: "auth",
                        content: "---\nscenario: standard\n---\n\nNavigate to /login and sign in",
                    },
                ],
            });

            const planBefore = await harness.db.testPlan.findFirstOrThrow({
                where: { testCase: { applicationId: app.id } },
                select: { scenarioId: true, scenarioName: true },
            });
            expect(planBefore.scenarioId).toBeNull();
            expect(planBefore.scenarioName).toBe("standard");

            await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
                version: 1,
                source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
                validationMode: "sdk-check",
                recipes: [
                    {
                        name: "standard",
                        description: "standard scenario",
                        create: { User: [{ name: "alice" }] },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                ],
            });

            const planAfter = await harness.db.testPlan.findFirstOrThrow({
                where: { testCase: { applicationId: app.id } },
                select: { scenarioId: true, scenarioName: true },
            });
            expect(planAfter.scenarioName).toBe("standard");
            expect(planAfter.scenarioId).not.toBeNull();

            const scenario = await harness.db.scenario.findFirstOrThrow({
                where: { applicationId: app.id, name: "standard" },
                select: { id: true },
            });
            expect(planAfter.scenarioId).toBe(scenario.id);
        });
    },
});
