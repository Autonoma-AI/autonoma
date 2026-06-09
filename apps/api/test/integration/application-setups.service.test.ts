import { ApplicationArchitecture } from "@autonoma/db";
import { ScenarioRecipeStore } from "@autonoma/scenario";
import type { ArtifactKey } from "@autonoma/types";
import { expect } from "vitest";
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

    const service = new ApplicationSetupService(
        harness.db,
        harness.generationProvider,
        harness.services.onboarding,
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
                        content: "---\nscenario: standard\n---\n\nNavigate to /login and sign in",
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

            await service.updateSetup(setupId, harness.organizationId, { status: "completed" });

            const completed = await harness.services.applicationSetups.artifactStatus(harness.organizationId, app.id);
            expect(completed.complete).toBe(true);
        });
    },
});
