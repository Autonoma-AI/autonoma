import { ApplicationArchitecture } from "@autonoma/db";
import { ScenarioRecipeStore } from "@autonoma/scenario";
import type { ArtifactKey } from "@autonoma/types";
import { expect } from "vitest";
import { ApplicationSetupService } from "../../src/application-setup/application-setup.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

// Ingestion parses every uploaded test case's frontmatter with TestCaseFrontmatterSchema, which
// requires a `description` of at least 20 characters - a fixture without one fails the upload.
const TEST_CASE_DESCRIPTION = "Signing in with valid credentials lands the user on the dashboard.";

async function createSetupFixture(harness: APITestHarness, name: string) {
    const app = await harness.services.applications.createApplication({
        name,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });

    // Mirror production wiring: the HTTP router hands the service the real
    // OnboardingManager (not the OnboardingService wrapper), so setup-completion
    // logic resolves to real manager methods.
    const service = new ApplicationSetupService(
        harness.db,
        harness.services.onboarding.manager,
        new ScenarioRecipeStore(harness.db),
    );
    const { id: setupId } = await service.createSetup(harness.userId, harness.organizationId, app.id, app.name);

    return { app, setupId, service };
}

function received(artifacts: { key: ArtifactKey; received: boolean }[], key: ArtifactKey): boolean {
    return artifacts.find((artifact) => artifact.key === key)?.received ?? false;
}

apiTestSuite({
    name: "application-setups-service",
    cases: (test) => {
        test("artifactStatus reports everything pending when no setup exists", async ({ harness }) => {
            const app = await harness.services.applications.createApplication({
                name: "Artifact Status Empty",
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/file.png",
            });

            const status = await harness.services.applicationSetups.artifactStatus(harness.organizationId, app.id);

            expect(status.complete).toBe(false);
            expect(status.artifacts.map((a) => a.key)).toEqual(["recipe", "tests", "kb", "scenarios"]);
            expect(status.artifacts.every((a) => !a.received)).toBe(true);
        });

        test("artifactStatus flips rows as artifacts arrive and completes when setup is completed", async ({
            harness,
        }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Artifact Status Progress");

            // Recipes first so scenarios exist before tests reference them.
            await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
                version: 1,
                source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
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

            const afterRecipe = await harness.services.applicationSetups.artifactStatus(harness.organizationId, app.id);
            expect(received(afterRecipe.artifacts, "recipe")).toBe(true);
            expect(received(afterRecipe.artifacts, "tests")).toBe(false);
            expect(received(afterRecipe.artifacts, "kb")).toBe(false);
            expect(received(afterRecipe.artifacts, "scenarios")).toBe(false);
            expect(afterRecipe.complete).toBe(false);

            await service.uploadArtifacts(setupId, harness.organizationId, {
                testCases: [
                    {
                        name: "login.md",
                        folder: "auth",
                        content:
                            "---\nscenario: standard\ndescription: Logging in with valid credentials lands the user on the dashboard.\n---\n\nNavigate to /login and sign in",
                    },
                ],
                artifacts: [
                    { name: "AUTONOMA.md", content: "# Knowledge base" },
                    { name: "scenarios.md", content: "# Scenarios" },
                ],
            });

            const afterArtifacts = await harness.services.applicationSetups.artifactStatus(
                harness.organizationId,
                app.id,
            );
            expect(received(afterArtifacts.artifacts, "recipe")).toBe(true);
            expect(received(afterArtifacts.artifacts, "tests")).toBe(true);
            expect(received(afterArtifacts.artifacts, "kb")).toBe(true);
            expect(received(afterArtifacts.artifacts, "scenarios")).toBe(true);
            expect(afterArtifacts.artifacts.find((a) => a.key === "tests")?.meta).toBe("1 file");
            // Not complete until the CLI marks the setup completed.
            expect(afterArtifacts.complete).toBe(false);

            // stepComplete stays false while the run is unfinished, even with every
            // artifact present, and only flips once the setup is marked completed.
            expect(afterArtifacts.stepComplete).toBe(false);

            await service.updateSetup(setupId, harness.organizationId, { status: "completed" });

            const completed = await harness.services.applicationSetups.artifactStatus(harness.organizationId, app.id);
            expect(completed.complete).toBe(true);
            expect(completed.stepComplete).toBe(true);
        });

        test("stepComplete stays false when the recipe is missing", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Missing Recipe Gate");

            // Everything but the recipe: tests + kb + scenarios, and the setup completed.
            await service.uploadArtifacts(setupId, harness.organizationId, {
                testCases: [
                    {
                        name: "login.md",
                        folder: "auth",
                        content: `---\ndescription: ${TEST_CASE_DESCRIPTION}\n---\n\nSign in`,
                    },
                ],
                artifacts: [
                    { name: "AUTONOMA.md", content: "# Knowledge base" },
                    { name: "scenarios.md", content: "# Scenarios" },
                ],
            });
            await service.updateSetup(setupId, harness.organizationId, { status: "completed" });

            const status = await harness.services.applicationSetups.artifactStatus(harness.organizationId, app.id);
            expect(status.complete).toBe(true);
            expect(received(status.artifacts, "recipe")).toBe(false);
            expect(status.stepComplete).toBe(false);
        });

        test("re-uploading recipe and artifacts is idempotent", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Idempotent Reupload");

            const recipeBody = {
                version: 1,
                source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
                validationMode: "sdk-check",
                recipes: [
                    {
                        name: "standard",
                        description: "standard",
                        create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                ],
            };
            const artifactsBody = {
                testCases: [
                    {
                        name: "login.md",
                        folder: "auth",
                        content: `---\nscenario: standard\ndescription: ${TEST_CASE_DESCRIPTION}\n---\n\nSign in`,
                    },
                ],
                artifacts: [
                    { name: "AUTONOMA.md", content: "# Knowledge base" },
                    { name: "scenarios.md", content: "# Scenarios" },
                ],
            };

            // Upload once, then a full retry of both endpoints.
            await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, recipeBody);
            await service.uploadArtifacts(setupId, harness.organizationId, artifactsBody);
            await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, recipeBody);
            await service.uploadArtifacts(setupId, harness.organizationId, artifactsBody);

            const testCaseCount = await harness.db.testCase.count({ where: { applicationId: app.id } });
            expect(testCaseCount).toBe(1);
            const scenarioCount = await harness.db.scenario.count({
                where: { applicationId: app.id, activeRecipeVersionId: { not: null } },
            });
            expect(scenarioCount).toBe(1);
            const fileEventCount = await harness.db.applicationSetupEvent.count({
                where: { setupId, type: "file.created" },
            });
            expect(fileEventCount).toBe(3);
        });

        test("a newer empty setup does not shadow a completed one", async ({ harness }) => {
            const { app, setupId, service } = await createSetupFixture(harness, "Artifact Status Shadowing");

            await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
                version: 1,
                source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
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
            await service.uploadArtifacts(setupId, harness.organizationId, {
                testCases: [
                    {
                        name: "login.md",
                        folder: "auth",
                        content: `---\nscenario: standard\ndescription: ${TEST_CASE_DESCRIPTION}\n---\n\nSign in`,
                    },
                ],
                artifacts: [
                    { name: "AUTONOMA.md", content: "# Knowledge base" },
                    { name: "scenarios.md", content: "# Scenarios" },
                ],
            });
            await service.updateSetup(setupId, harness.organizationId, { status: "completed" });

            // A fresh Finish-setup page load mints a new, empty setup that is newer
            // than the completed one. Status must still reflect the completed run.
            await service.createSetup(harness.userId, harness.organizationId, app.id);

            const status = await harness.services.applicationSetups.artifactStatus(harness.organizationId, app.id);
            expect(status.complete).toBe(true);
            expect(received(status.artifacts, "recipe")).toBe(true);
            expect(received(status.artifacts, "tests")).toBe(true);
            expect(received(status.artifacts, "kb")).toBe(true);
            expect(received(status.artifacts, "scenarios")).toBe(true);
        });

        test("prepareCliSetup reuses the existing setup instead of minting a new one", async ({ harness }) => {
            const { app } = await createSetupFixture(harness, "Prepare CLI Reuse");
            const before = await harness.db.applicationSetup.count({ where: { applicationId: app.id } });

            const first = await harness.services.applicationSetups.prepareCliSetup(
                harness.userId,
                harness.organizationId,
                app.id,
            );
            const second = await harness.services.applicationSetups.prepareCliSetup(
                harness.userId,
                harness.organizationId,
                app.id,
            );

            expect(second.setupId).toBe(first.setupId);
            const after = await harness.db.applicationSetup.count({ where: { applicationId: app.id } });
            expect(after).toBe(before);

            // An explicit setup id pins to that setup.
            const pinned = await harness.services.applicationSetups.prepareCliSetup(
                harness.userId,
                harness.organizationId,
                app.id,
                first.setupId,
            );
            expect(pinned.setupId).toBe(first.setupId);
        });
    },
});
