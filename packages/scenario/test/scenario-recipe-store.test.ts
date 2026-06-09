import { integrationTestSuite } from "@autonoma/integration-test";
import type { ScenarioRecipeVariables, ScenarioRecipesFile } from "@autonoma/types";
import { expect } from "vitest";
import { ScenarioRecipeStore } from "../src/scenario-recipe-store";
import { ScenarioTestHarness } from "./scenario-harness";

const SIGNING_SECRET = "test-secret";

function makeRecipe(name: string, description: string, organizationName: string, variables?: ScenarioRecipeVariables) {
    return {
        name,
        description,
        create: {
            Organization: [{ _alias: "org1", name: organizationName }],
        },
        ...(variables != null ? { variables } : {}),
        validation: { status: "validated", method: "checkScenario", phase: "ok", up_ms: 1, down_ms: 1 },
    };
}

function makeRecipesFile(recipes: ScenarioRecipesFile["recipes"]): ScenarioRecipesFile {
    return {
        version: 1,
        source: {
            discoverPath: "autonoma/discover.json",
            scenariosPath: "autonoma/scenarios.md",
        },
        validationMode: "sdk-check",
        recipes,
    };
}

integrationTestSuite({
    name: "ScenarioRecipeStore",
    createHarness: () => ScenarioTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const { appId } = await harness.createApp(orgId, {
            webhookUrl: harness.webhookServer.url,
            signingSecret: SIGNING_SECRET,
        });
        const store = new ScenarioRecipeStore(harness.db);
        return { orgId, appId, store };
    },
    cases: (test) => {
        test("replaceScenarioRecipes: creates scenarios", async ({ harness, seedResult: { orgId, store } }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
                    makeRecipe("checkout", "Checkout flow", "Acme Corp"),
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            });

            const scenarios = await harness.db.scenario.findMany({
                where: { applicationId: appId, isDisabled: false },
                orderBy: { name: "asc" },
                select: {
                    id: true,
                    name: true,
                    description: true,
                    activeRecipeVersionId: true,
                    lastSeenFingerprint: true,
                },
            });
            const schemaSnapshots = await harness.db.scenarioSchemaSnapshot.findMany({
                where: { applicationId: appId },
                select: { snapshotId: true, structureJson: true },
            });
            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { applicationId: appId },
                orderBy: { scenarioNameSnapshot: "asc" },
                select: {
                    scenarioNameSnapshot: true,
                    fixtureJson: true,
                    schemaSnapshotId: true,
                    snapshotId: true,
                    fingerprint: true,
                },
            });

            expect(scenarios).toHaveLength(3);
            expect(scenarios[0]?.name).toBe("checkout");
            expect(scenarios[0]?.description).toBe("Checkout flow");
            expect(scenarios[0]?.activeRecipeVersionId).toBeTruthy();
            expect(scenarios[0]?.lastSeenFingerprint).toMatch(/^[a-f0-9]{64}$/);
            expect(scenarios[1]?.name).toBe("empty");
            expect(schemaSnapshots).toHaveLength(1);
            expect(schemaSnapshots[0]?.snapshotId).toBe(snapshotId);
            expect(recipeVersions).toHaveLength(3);
            expect(recipeVersions[0]?.scenarioNameSnapshot).toBe("checkout");
            expect(recipeVersions[0]?.fixtureJson).toBeTruthy();
            expect(recipeVersions[0]?.schemaSnapshotId).toBeTruthy();
            expect(recipeVersions[0]?.snapshotId).toBe(snapshotId);
            expect(recipeVersions[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
        });

        test("replaceScenarioRecipes: updates existing scenarios and disables stale ones", async ({
            harness,
            seedResult: { orgId, store },
        }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);

            await harness.db.scenario.create({
                data: {
                    name: "checkout",
                    description: "Old description",
                    lastSeenFingerprint: "v1",
                    application: { connect: { id: appId } },
                    organization: { connect: { id: orgId } },
                },
            });
            await harness.db.scenario.create({
                data: {
                    name: "stale",
                    description: "Stale scenario",
                    application: { connect: { id: appId } },
                    organization: { connect: { id: orgId } },
                },
            });

            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([makeRecipe("checkout", "Updated description", "Updated Org")]),
            });

            const scenario = await harness.db.scenario.findUnique({
                where: { applicationId_name: { applicationId: appId, name: "checkout" } },
                select: {
                    id: true,
                    description: true,
                    activeRecipeVersionId: true,
                    lastSeenFingerprint: true,
                    fingerprintChangedAt: true,
                },
            });
            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { applicationId: appId, scenarioNameSnapshot: "checkout" },
                orderBy: { createdAt: "asc" },
                select: { id: true, fixtureJson: true, snapshotId: true },
            });
            expect(scenario?.description).toBe("Updated description");
            expect(scenario?.lastSeenFingerprint).not.toBe("v1");
            expect(scenario?.activeRecipeVersionId).toBeTruthy();
            expect(scenario?.fingerprintChangedAt).not.toBeNull();
            expect(recipeVersions).toHaveLength(1);
            expect(recipeVersions[0]?.fixtureJson).toBeTruthy();

            const stale = await harness.db.scenario.findUnique({
                where: { applicationId_name: { applicationId: appId, name: "stale" } },
            });
            expect(stale?.isDisabled).toBe(true);
        });

        test("replaceScenarioRecipes: re-uploading for the same snapshot replaces recipe versions", async ({
            harness,
            seedResult: { orgId, store },
        }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);

            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([makeRecipe("checkout", "Checkout flow", "Acme Corp")]),
            });
            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([makeRecipe("checkout", "Checkout flow", "Globex Corp")]),
            });

            const schemaSnapshots = await harness.db.scenarioSchemaSnapshot.findMany({
                where: { applicationId: appId },
                select: { id: true },
            });
            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { applicationId: appId, scenarioNameSnapshot: "checkout" },
                select: { id: true, fixtureJson: true },
            });
            const activeScenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "checkout" } },
                select: { activeRecipeVersionId: true },
            });

            // Same snapshot - schema snapshot is upserted, recipe version replaced (not accumulated)
            expect(schemaSnapshots).toHaveLength(1);
            expect(recipeVersions).toHaveLength(1);
            expect(activeScenario.activeRecipeVersionId).toBe(recipeVersions[0]?.id);
            expect((recipeVersions[0]?.fixtureJson as { create?: unknown })?.create).toEqual({
                Organization: [{ _alias: "org1", name: "Globex Corp" }],
            });
        });

        test("replaceScenarioRecipes: different snapshots create separate schema snapshot rows", async ({
            harness,
            seedResult: { orgId, store },
        }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);

            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([makeRecipe("checkout", "Checkout flow", "Acme Corp")]),
            });

            const branch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: appId },
                select: { id: true },
            });
            const snapshot2 = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "MANUAL", status: "active" },
            });

            await store.replaceScenarioRecipes({
                snapshotId: snapshot2.id,
                applicationId: appId,
                recipesFile: makeRecipesFile([
                    {
                        name: "checkout",
                        description: "Checkout flow",
                        create: {
                            Organization: [{ _alias: "org1", name: "Acme Corp" }],
                            User: [{ _alias: "user1", email: "owner@example.com", organizationId: { _ref: "org1" } }],
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                ]),
            });

            const schemaSnapshots = await harness.db.scenarioSchemaSnapshot.findMany({
                where: { applicationId: appId },
                orderBy: { createdAt: "asc" },
                select: { snapshotId: true, structureJson: true },
            });
            const recipeVersions = await harness.db.scenarioRecipeVersion.findMany({
                where: { applicationId: appId, scenarioNameSnapshot: "checkout" },
                orderBy: { createdAt: "asc" },
                select: { snapshotId: true },
            });

            expect(schemaSnapshots).toHaveLength(2);
            expect(schemaSnapshots[0]?.snapshotId).toBe(snapshotId);
            expect(schemaSnapshots[1]?.snapshotId).toBe(snapshot2.id);
            expect((schemaSnapshots[1]?.structureJson as { models?: Record<string, unknown> })?.models).toHaveProperty(
                "User",
            );
            expect(recipeVersions).toHaveLength(2);
            expect(recipeVersions[0]?.snapshotId).toBe(snapshotId);
            expect(recipeVersions[1]?.snapshotId).toBe(snapshot2.id);
        });

        test("replaceScenarioRecipes: throws when application does not exist", async ({ seedResult: { store } }) => {
            await expect(
                store.replaceScenarioRecipes({
                    snapshotId: "snapshot-1",
                    applicationId: "nonexistent-app",
                    recipesFile: makeRecipesFile([makeRecipe("x", "y", "z")]),
                }),
            ).rejects.toThrow("Application nonexistent-app not found");
        });

        test("loadRecipePayload: resolves faker variables deterministically for the same testRunId", async ({
            harness,
            seedResult: { appId, store },
        }) => {
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await store.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
                    {
                        name: "faker",
                        description: "Faker variables",
                        create: {
                            User: [{ firstName: "{{owner_first_name}}", email: "{{owner_email}}" }],
                        },
                        variables: {
                            owner_first_name: { strategy: "faker", generator: "person.firstName" },
                            owner_email: { strategy: "faker", generator: "internet.email" },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            });

            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "faker" } },
                select: { id: true },
            });

            const resultA = await store.loadRecipePayload({ scenarioId: scenario.id, testRunId: "run-123" });
            const resultB = await store.loadRecipePayload({ scenarioId: scenario.id, testRunId: "run-123" });
            const resultC = await store.loadRecipePayload({ scenarioId: scenario.id, testRunId: "run-456" });

            expect(resultA).toEqual(resultB);
            expect(resultA).not.toEqual(resultC);
            expect(resultA?.resolvedVariables).toHaveProperty("owner_first_name");
            expect(resultA?.resolvedVariables).toHaveProperty("owner_email");
        });

        test("loadRecipePayload: returns null when scenario has no recipe", async ({
            harness,
            seedResult: { orgId, appId, store },
        }) => {
            const scenario = await harness.db.scenario.create({
                data: { organizationId: orgId, applicationId: appId, name: "no-recipe" },
            });
            const result = await store.loadRecipePayload({ scenarioId: scenario.id, testRunId: "run-1" });
            expect(result).toBeNull();
        });

        test("loadRecipePayload: returns null for snapshot with no pinned recipe", async ({
            harness,
            seedResult: { orgId, appId, store },
        }) => {
            const scenario = await harness.db.scenario.create({
                data: { organizationId: orgId, applicationId: appId, name: "no-pinned" },
            });
            const result = await store.loadRecipePayload({
                scenarioId: scenario.id,
                snapshotId: "missing-snapshot",
                testRunId: "run-1",
            });
            expect(result).toBeNull();
        });
    },
});
