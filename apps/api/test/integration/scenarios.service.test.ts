import { ApplicationArchitecture } from "@autonoma/db";
import { ScenarioRecipeStore } from "@autonoma/scenario";
import type { ScenarioRecipe } from "@autonoma/types";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { ApplicationSetupService } from "../../src/application-setup/application-setup.service";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

function makeRecipe(overrides: Partial<ScenarioRecipe> = {}): ScenarioRecipe {
    return {
        name: "standard",
        description: "standard",
        create: { User: [{ _alias: "user1", name: "Alice" }] },
        validation: { status: "validated", method: "checkScenario", phase: "ok" },
        ...overrides,
    };
}

async function createFixture(harness: APITestHarness, name: string) {
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

    await service.uploadScenarioRecipeVersions(setupId, harness.organizationId, {
        version: 1,
        source: { discoverPath: "autonoma/discover.json", scenariosPath: "autonoma/scenarios.md" },
        validationMode: "sdk-check",
        recipes: [makeRecipe()],
    });

    const scenario = await harness.db.scenario.findFirstOrThrow({
        where: { applicationId: app.id, name: "standard" },
        select: { id: true, activeRecipeVersionId: true },
    });

    if (app.mainBranchId == null) throw new Error("Application has no main branch");
    return { app, service: harness.services.scenarios, scenario, branchId: app.mainBranchId };
}

apiTestSuite({
    name: "scenarios-service",
    cases: (test) => {
        test("updateRecipe updates the active recipe and scenario metadata", async ({ harness }) => {
            const { service, scenario } = await createFixture(harness, "Scenario Recipe Active Update");
            const nextRecipe = makeRecipe({
                description: "updated active",
                create: { User: [{ _alias: "user1", name: "Bob" }] },
            });

            const result = await service.updateRecipe(scenario.id, JSON.stringify(nextRecipe), harness.organizationId);

            expect(result.updatedRecipeVersions).toEqual([
                { id: scenario.activeRecipeVersionId, snapshotId: expect.any(String), target: "active" },
            ]);

            const updatedScenario = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: {
                    description: true,
                    lastSeenFingerprint: true,
                    fingerprintChangedAt: true,
                    activeRecipeVersion: { select: { fixtureJson: true, fingerprint: true } },
                },
            });
            expect(updatedScenario.description).toBe("updated active");
            expect(updatedScenario.fingerprintChangedAt).toBeTruthy();
            expect(updatedScenario.activeRecipeVersion?.fixtureJson).toEqual(nextRecipe);
            expect(updatedScenario.activeRecipeVersion?.fingerprint).toBe(updatedScenario.lastSeenFingerprint);
        });

        test("updateRecipe updates active and pending main snapshot recipe rows", async ({ harness }) => {
            const { service, scenario, branchId } = await createFixture(harness, "Scenario Recipe Pending Update");
            const { snapshotId: pendingSnapshotId } = await harness.request().snapshotEdit.start({ branchId });
            const pendingBefore = await harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
                select: { id: true },
            });
            const nextRecipe = makeRecipe({
                description: "updated pending",
                create: { User: [{ _alias: "user1", name: "Pending Bob" }] },
            });

            const result = await service.updateRecipe(scenario.id, JSON.stringify(nextRecipe), harness.organizationId);

            expect(result.updatedRecipeVersions).toEqual([
                { id: scenario.activeRecipeVersionId, snapshotId: expect.any(String), target: "active" },
                { id: pendingBefore.id, snapshotId: pendingSnapshotId, target: "pending" },
            ]);

            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { scenarioId: scenario.id, id: { in: result.updatedRecipeVersions.map((rv) => rv.id) } },
                select: { fixtureJson: true },
            });
            expect(recipeVersions).toHaveLength(2);
            expect(recipeVersions.every((rv) => JSON.stringify(rv.fixtureJson) === JSON.stringify(nextRecipe))).toBe(
                true,
            );
        });

        test("updateRecipe creates the pending recipe row when it is missing", async ({ harness }) => {
            const { service, scenario, branchId } = await createFixture(harness, "Scenario Recipe Missing Pending");
            const { snapshotId: pendingSnapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.db.scenarioRecipeVersion.delete({
                where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
            });
            const nextRecipe = makeRecipe({
                description: "created pending",
                create: { User: [{ _alias: "user1", name: "Created Pending" }] },
            });

            const result = await service.updateRecipe(scenario.id, JSON.stringify(nextRecipe), harness.organizationId);

            const pendingResult = result.updatedRecipeVersions.find((rv) => rv.target === "pending");
            expect(pendingResult?.snapshotId).toBe(pendingSnapshotId);

            const pendingRecipe = await harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                where: { scenarioId_snapshotId: { scenarioId: scenario.id, snapshotId: pendingSnapshotId } },
                select: { id: true, fixtureJson: true },
            });
            expect(pendingRecipe.id).toBe(pendingResult?.id);
            expect(pendingRecipe.fixtureJson).toEqual(nextRecipe);
        });

        test("updateRecipe rejects invalid JSON and invalid recipe schema", async ({ harness }) => {
            const { service, scenario } = await createFixture(harness, "Scenario Recipe Invalid Input");

            await expect(service.updateRecipe(scenario.id, "{", harness.organizationId)).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: "Invalid JSON syntax",
            });

            await expect(
                service.updateRecipe(scenario.id, JSON.stringify({ name: "standard" }), harness.organizationId),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
            });
        });

        test("updateRecipe rejects recipe renames", async ({ harness }) => {
            const { service, scenario } = await createFixture(harness, "Scenario Recipe Rename Rejected");
            const renamedRecipe = makeRecipe({ name: "renamed" });

            await expect(
                service.updateRecipe(scenario.id, JSON.stringify(renamedRecipe), harness.organizationId),
            ).rejects.toMatchObject({
                code: "BAD_REQUEST",
                message: 'Recipe name must remain "standard"',
            });
        });

        test("updateRecipe remains admin-only through the router", async ({ harness }) => {
            const { scenario } = await createFixture(harness, "Scenario Recipe Router Forbidden");
            const before = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });

            await expect(
                harness.request().scenarios.updateRecipe({
                    scenarioId: scenario.id,
                    fixtureJson: JSON.stringify(makeRecipe({ description: "should not save" })),
                }),
            ).rejects.toBeInstanceOf(TRPCError);

            const after = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenario.id },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });
            expect(after.activeRecipeVersion?.fixtureJson).toEqual(before.activeRecipeVersion?.fixtureJson);
        });

        test("dryRun rejects a scenario that belongs to another application", async ({ harness }) => {
            const { service, app } = await createFixture(harness, "Scenario Dry Run Owner App");
            const { scenario: foreignScenario } = await createFixture(harness, "Scenario Dry Run Other App");

            // dryRun scopes the scenario to its application, so a scenario from another
            // app is rejected up front - a caller can't run another tenant's recipe
            // against their own (SDK-controlled) app.
            await expect(service.dryRun(app.id, harness.organizationId, foreignScenario.id)).rejects.toThrow(
                "Scenario not found",
            );
        });
    },
});
