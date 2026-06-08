import { integrationTestSuite } from "@autonoma/integration-test";
import type { ScenarioRecipeVariables, ScenarioRecipesFile } from "@autonoma/types";
import { expect } from "vitest";
import { ScenarioManager } from "../src/scenario-manager";
import { ScenarioRecipeStore } from "../src/scenario-recipe-store";
import { GenerationSubject } from "../src/scenario-subject";
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
    name: "ScenarioManager",
    createHarness: () => ScenarioTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const { appId, deploymentId } = await harness.createApp(orgId, {
            webhookUrl: harness.webhookServer.url,
            signingSecret: SIGNING_SECRET,
        });
        const manager = new ScenarioManager(harness.db, harness.encryption);
        return { orgId, appId, deploymentId, manager };
    },
    cases: (test) => {
        test("ingestScenarioRecipes: creates scenarios", async ({ harness, seedResult: { orgId, manager } }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    makeRecipe("checkout", "Checkout flow", "Acme Corp"),
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );

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

        test("ingestScenarioRecipes: updates existing scenarios and disables stale ones", async ({
            harness,
            seedResult: { orgId, manager },
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

            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([makeRecipe("checkout", "Updated description", "Updated Org")]),
            );

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

        test("ingestScenarioRecipes: re-uploading for the same snapshot replaces recipe versions", async ({
            harness,
            seedResult: { orgId, manager },
        }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);

            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([makeRecipe("checkout", "Checkout flow", "Acme Corp")]),
            );
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([makeRecipe("checkout", "Checkout flow", "Globex Corp")]),
            );

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

        test("ingestScenarioRecipes: different snapshots create separate schema snapshot rows", async ({
            harness,
            seedResult: { orgId, manager },
        }) => {
            const { appId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const snapshotId = await harness.getMainBranchSnapshotId(appId);

            // First upload on snapshotId
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([makeRecipe("checkout", "Checkout flow", "Acme Corp")]),
            );

            // Create a second snapshot
            const branch = await harness.db.branch.findFirstOrThrow({
                where: { applicationId: appId },
                select: { id: true },
            });
            const snapshot2 = await harness.db.branchSnapshot.create({
                data: { branchId: branch.id, source: "MANUAL", status: "active" },
            });

            // Second upload on different snapshot with different structure
            await manager.ingestScenarioRecipes(
                snapshot2.id,
                appId,
                makeRecipesFile([
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
            );

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

        test("ingestScenarioRecipes: throws when application does not exist", async ({ seedResult: { manager } }) => {
            await expect(
                manager.ingestScenarioRecipes(
                    "snapshot-1",
                    "nonexistent-app",
                    makeRecipesFile([makeRecipe("x", "y", "z")]),
                ),
            ).rejects.toThrow("Application nonexistent-app not found");
        });

        test("up: creates instance and calls webhook", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: {
                    auth: { token: "session-abc" },
                    refs: { userId: "user-1" },
                    refsToken: "ref-tok",
                    expiresInSeconds: 1800,
                },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "checkout", {
                Organization: [{ _alias: "org1", name: "Acme Corp" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenarioId);

            expect(instance.status).toBe("UP_SUCCESS");
            expect(instance.auth).toEqual({ token: "session-abc" });
            expect(instance.refs).toEqual({ userId: "user-1" });
            expect(instance.refsToken).toBe("ref-tok");
            expect(instance.upAt).not.toBeNull();

            expect(harness.webhookServer.requests).toHaveLength(1);
            expect(harness.webhookServer.requests[0]?.body).toMatchObject({
                action: "up",
                create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
            });

            // Verify the generation was linked to the instance
            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: generationId },
                select: { scenarioInstanceId: true },
            });
            expect(generation.scenarioInstanceId).toBe(instance.id);
        });

        test("up: resolves literal variables before webhook call", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "literal",
                        description: "Literal variables",
                        create: {
                            Organization: [{ _alias: "org1", name: "{{org_name}}" }],
                        },
                        variables: {
                            org_name: { strategy: "literal", value: "Acme Corp" },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );

            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "literal" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await manager.up(subject, scenario.id);

            expect(harness.webhookServer.requests[0]?.body).toMatchObject({
                action: "up",
                create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
            });
        });

        test("up: resolves derived variables from instance id", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "derived",
                        description: "Derived variables",
                        create: {
                            User: [{ email: "{{owner_email}}" }],
                        },
                        variables: {
                            owner_email: {
                                strategy: "derived",
                                source: "testRunId",
                                format: "owner+{testRunId}@example.com",
                            },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );

            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "derived" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenario.id);

            expect(harness.webhookServer.requests[0]?.body).toMatchObject({
                action: "up",
                create: { User: [{ email: `owner+${instance.id}@example.com` }] },
                testRunId: instance.id,
            });
        });

        test("up: resolves faker variables deterministically for the same instance id", async ({
            harness,
            seedResult: { appId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
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
            );

            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "faker" } },
                select: { id: true },
            });
            const store = new ScenarioRecipeStore(harness.db);

            const resultA = await store.loadActiveRecipeCreatePayload({
                scenarioId: scenario.id,
                testRunId: "run-123",
            });
            const resultB = await store.loadActiveRecipeCreatePayload({
                scenarioId: scenario.id,
                testRunId: "run-123",
            });
            const resultC = await store.loadActiveRecipeCreatePayload({
                scenarioId: scenario.id,
                testRunId: "run-456",
            });

            expect(resultA).toEqual(resultB);
            expect(resultA).not.toEqual(resultC);
            expect(resultA?.resolvedVariables).toHaveProperty("owner_first_name");
            expect(resultA?.resolvedVariables).toHaveProperty("owner_email");
        });

        test("up: stores resolved variables on instance after successful up", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "with-vars",
                        description: "With variables",
                        create: {
                            User: [{ firstName: "{{first_name}}", email: "{{user_email}}" }],
                        },
                        variables: {
                            first_name: { strategy: "faker", generator: "person.firstName" },
                            user_email: {
                                strategy: "derived",
                                source: "testRunId",
                                format: "user+{testRunId}@example.com",
                            },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );

            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "with-vars" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenario.id);

            expect(instance.status).toBe("UP_SUCCESS");
            const vars = instance.resolvedVariables as Record<string, unknown>;
            expect(vars).toBeDefined();
            expect(vars.first_name).toEqual(expect.any(String));
            expect(vars.user_email).toContain(`user+${instance.id}@example.com`);
        });

        test("up: persists resolved create-spec as generatedData after successful up", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "generated-data",
                        description: "Generated data",
                        create: {
                            Organization: [{ _alias: "org1", name: "{{org_name}}" }],
                            User: [{ email: "{{owner_email}}", organizationId: { _ref: "org1" } }],
                        },
                        variables: {
                            org_name: { strategy: "literal", value: "Acme Corp" },
                            owner_email: {
                                strategy: "derived",
                                source: "testRunId",
                                format: "owner+{testRunId}@example.com",
                            },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );

            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "generated-data" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenario.id);

            expect(instance.status).toBe("UP_SUCCESS");

            // Re-read from the DB to confirm the field was persisted, not just returned.
            const persisted = await harness.db.scenarioInstance.findUniqueOrThrow({
                where: { id: instance.id },
                select: { generatedData: true },
            });
            expect(persisted.generatedData).toEqual({
                Organization: [{ _alias: "org1", name: "Acme Corp" }],
                User: [{ email: `owner+${instance.id}@example.com`, organizationId: { _ref: "org1" } }],
            });
        });

        test("up: resolvedVariables is null when recipe has no variables", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "no-vars", {
                Organization: [{ _alias: "org1", name: "Acme Corp" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenarioId);

            expect(instance.status).toBe("UP_SUCCESS");
            expect(instance.resolvedVariables).toBeNull();
        });

        test("up: sends stored recipe create payload key order unchanged", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: {
                    auth: { token: "session-abc" },
                    refs: { userId: "user-1" },
                    refsToken: "ref-tok",
                },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "unordered",
                        description: "unordered",
                        create: {
                            Task: [
                                {
                                    _alias: "task1",
                                    title: "{{task_title}}",
                                    organizationId: { _ref: "org1" },
                                    projectId: { _ref: "proj1" },
                                },
                            ],
                            Project: [{ _alias: "proj1", name: "Project", organizationId: { _ref: "org1" } }],
                            Organization: [{ _alias: "org1", name: "Acme Corp" }],
                        },
                        variables: {
                            task_title: { strategy: "literal", value: "Task" },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );
            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "unordered" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await manager.up(subject, scenario.id);

            const createPayload = harness.webhookServer.requests[0]?.body.create as Record<string, unknown[]>;
            expect(Object.keys(createPayload ?? {})).toEqual(["Task", "Project", "Organization"]);
            expect(createPayload.Task?.[0]).toMatchObject({ title: "Task" });
        });

        test("up: marks instance as UP_FAILED when webhook fails", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 500,
                body: { error: "internal" },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "checkout-fail", {
                Organization: [{ _alias: "org1", name: "Acme Corp" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenarioId);

            expect(instance.status).toBe("UP_FAILED");
            expect(instance.lastError).toEqual({ message: "Webhook returned HTTP 500: internal" });
            expect(instance.completedAt).not.toBeNull();
        });

        test("up: throws when scenario does not exist", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);
            await expect(manager.up(subject, "nonexistent-scenario")).rejects.toThrow("not found");
        });

        test("up: fails clearly when scenario recipe is missing", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const scenarioId = await harness.createScenario(orgId, appId, "checkout-missing-recipe");
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenarioId)).rejects.toThrow("does not have a stored recipe version");
        });

        test("up: fails clearly when token exists in create but no variable definition exists", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "missing-variable",
                        description: "Missing variable",
                        create: {
                            User: [{ email: "{{owner_email}}" }],
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );
            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "missing-variable" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenario.id)).rejects.toThrow("Unknown recipe variable: owner_email");
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("up: fails clearly when variable definition is unused", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "unused-variable",
                        description: "Unused variable",
                        create: {
                            Organization: [{ name: "Acme Corp" }],
                        },
                        variables: {
                            owner_email: {
                                strategy: "derived",
                                source: "testRunId",
                                format: "owner+{testRunId}@example.com",
                            },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );
            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "unused-variable" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenario.id)).rejects.toThrow("Unused variable definition: owner_email");
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("up: fails clearly on unsupported faker generator", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await manager.ingestScenarioRecipes(
                snapshotId,
                appId,
                makeRecipesFile([
                    {
                        name: "bad-faker",
                        description: "Bad faker",
                        create: {
                            User: [{ email: "{{owner_email}}" }],
                        },
                        variables: {
                            owner_email: { strategy: "faker", generator: "internet.userHandle" },
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            );
            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "bad-faker" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenario.id)).rejects.toThrow(
                "Unsupported faker generator: internet.userHandle",
            );
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("down: tears down instance and calls webhook", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: { id: "r1" }, refsToken: "tok" },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "checkout-down", {
                Organization: [{ _alias: "org1", name: "Acme Corp" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);
            const upInstance = await manager.up(subject, scenarioId);

            harness.webhookServer.reset();
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { ok: true },
            }));

            const instance = await manager.down(upInstance.id);

            expect(instance).toBeDefined();
            expect(instance?.status).toBe("DOWN_SUCCESS");
            expect(instance?.downAt).not.toBeNull();
            expect(instance?.completedAt).not.toBeNull();

            expect(harness.webhookServer.requests).toHaveLength(1);
            const body = harness.webhookServer.requests[0]?.body as Record<string, unknown>;
            expect(body.action).toBe("down");
        });

        test("down: returns undefined when no instance exists", async ({ seedResult: { manager } }) => {
            const result = await manager.down("nonexistent-instance");
            expect(result).toBeUndefined();
        });

        test("down: skips already torn down instance", async ({ harness, seedResult: { orgId, appId, manager } }) => {
            const scenarioId = await harness.createScenario(orgId, appId, "checkout-skip");

            const instance = await harness.db.scenarioInstance.create({
                data: {
                    organizationId: orgId,
                    applicationId: appId,
                    scenarioId,
                    status: "DOWN_SUCCESS",
                    downAt: new Date(),
                    completedAt: new Date(),
                },
            });

            const result = await manager.down(instance.id);

            expect(result?.status).toBe("DOWN_SUCCESS");
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("down: marks instance as DOWN_FAILED when webhook fails", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "checkout-fail-down", {
                Organization: [{ _alias: "org1", name: "Acme Corp" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);
            const upInstance = await manager.up(subject, scenarioId);

            harness.webhookServer.reset();
            harness.webhookServer.onRequest(() => ({
                status: 500,
                body: { error: "teardown failed" },
            }));

            const instance = await manager.down(upInstance.id);

            expect(instance?.status).toBe("DOWN_FAILED");
            expect(instance?.lastError).not.toBeNull();
            expect(instance?.downAt).not.toBeNull();
            expect(instance?.completedAt).not.toBeNull();
        }, 60_000);
    },
});
