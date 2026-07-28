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
        const recipeStore = new ScenarioRecipeStore(harness.db);
        return { orgId, appId, deploymentId, manager, recipeStore };
    },
    cases: (test) => {
        test("up: creates instance and calls SDK endpoint", async ({
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

        test("up: rejects a scenario that belongs to another application", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const otherOrgId = await harness.createOrg();
            const { appId: otherAppId } = await harness.createApp(otherOrgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            const foreignScenarioId = await harness.createScenario(otherOrgId, otherAppId, "foreign", {
                Organization: [{ _alias: "org1", name: "Other Corp" }],
            });

            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, foreignScenarioId)).rejects.toThrow(
                `Scenario "${foreignScenarioId}" not found for application`,
            );
            // The tenant guard must trip before any SDK call goes out.
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("up: resolves literal variables before SDK call", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager, recipeStore },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await recipeStore.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
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
            });

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
            seedResult: { orgId, appId, deploymentId, manager, recipeStore },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await recipeStore.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
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
            });

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

        test("up: stores resolved variables on instance after successful up", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager, recipeStore },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await recipeStore.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
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
            });

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
            seedResult: { orgId, appId, deploymentId, manager, recipeStore },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await recipeStore.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
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
            });

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
            seedResult: { orgId, appId, deploymentId, manager, recipeStore },
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
            await recipeStore.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
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
            });
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

        test("up: marks instance as UP_FAILED when SDK call fails", async ({
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
            expect(instance.lastError).toEqual({ message: "SDK returned HTTP 500: internal" });
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

        test("down: tears down against the endpoint up was pointed at, not the stored one", async ({
            harness,
            seedResult: { orgId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: {}, refsToken: "tok" },
            }));

            // Its OWN app, whose stored endpoint points at a port nothing listens on: any call that
            // ignores the override fails outright, so reaching the webhook server proves it was used.
            // A fresh app rather than editing the seeded one, which the whole suite shares.
            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: "http://127.0.0.1:1/never-listening",
                signingSecret: SIGNING_SECRET,
            });
            const scenarioId = await harness.createScenario(orgId, appId, "targeted", {
                Organization: [{ name: "Acme Corp" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);
            const override = harness.webhookServer.url;

            const instance = await manager.up(subject, scenarioId, { sdkUrlOverride: override });
            const torn = await manager.down(instance.id, undefined, override);

            expect(instance.status).toBe("UP_SUCCESS");
            expect(torn?.status).toBe("DOWN_SUCCESS");
            // Both halves reached the overridden endpoint: an up here and a down here.
            expect(harness.webhookServer.requests.map((request) => request.body.action)).toEqual(["up", "down"]);
        });

        test("up: provisions a candidate recipe without storing it", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const scenarioId = await harness.createScenario(orgId, appId, "candidate", {
                Organization: [{ name: "Stored Org" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenarioId, {
                candidateRecipe: {
                    name: "candidate",
                    description: "An edit being tried out",
                    create: { Organization: [{ name: "Candidate Org" }] },
                    validation: { status: "validated", method: "checkScenario", phase: "ok" },
                },
            });

            expect(instance.status).toBe("UP_SUCCESS");
            // The candidate reached the SDK...
            expect(harness.webhookServer.requests[0]?.body.create.Organization[0].name).toBe("Candidate Org");
            // ...but the recipe every future run uses is untouched.
            const stored = await harness.db.scenario.findUniqueOrThrow({
                where: { id: scenarioId },
                select: { activeRecipeVersion: { select: { fixtureJson: true } } },
            });
            expect(stored.activeRecipeVersion?.fixtureJson).toMatchObject({
                create: { Organization: [{ name: "Stored Org" }] },
            });
        });

        test("up: resolves a candidate recipe's tokens against the instance it provisions", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const scenarioId = await harness.createScenario(orgId, appId, "candidate-tokens", {
                Organization: [{ name: "Stored Org" }],
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenarioId, {
                candidateRecipe: {
                    name: "candidate-tokens",
                    description: "An edit using the run identity",
                    create: { User: [{ externalId: "{{testRunId}}" }] },
                    validation: { status: "validated", method: "checkScenario", phase: "ok" },
                },
            });

            expect(harness.webhookServer.requests[0]?.body.create.User[0].externalId).toBe(instance.id);
        });

        test("up: substitutes the built-in run-identity tokens with the id sent to the SDK", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager, recipeStore },
        }) => {
            const snapshotId = await harness.getMainBranchSnapshotId(appId);
            await recipeStore.replaceScenarioRecipes({
                snapshotId,
                applicationId: appId,
                recipesFile: makeRecipesFile([
                    {
                        name: "run-identity",
                        description: "Uses the built-in tokens",
                        create: {
                            User: [{ externalId: "{{testRunId}}", username: "admin-{{testRunShortId}}" }],
                        },
                        validation: { status: "validated", method: "checkScenario", phase: "ok" },
                    },
                    makeRecipe("empty", "Empty state", "Empty Org"),
                    makeRecipe("large", "Large state", "Large Org"),
                ]),
            });
            const scenario = await harness.db.scenario.findUniqueOrThrow({
                where: { applicationId_name: { applicationId: appId, name: "run-identity" } },
                select: { id: true },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenario.id);

            expect(instance.status).toBe("UP_SUCCESS");
            const request = harness.webhookServer.requests[0];
            expect(request?.body.testRunId).toBe(instance.id);
            expect(request?.body.create.User[0].externalId).toBe(instance.id);
            expect(request?.body.create.User[0].username).toMatch(/^admin-[0-9a-f]{8}$/);
        });

        test("up: refuses to provision a stored recipe whose tokens cannot resolve", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            // Predates the upload-time check, so it can only arrive by a direct write.
            const scenarioId = await harness.createScenario(orgId, appId, "missing-variable", {
                Organization: [{ name: "Acme Corp" }],
            });
            await harness.overwriteRecipeFixture(scenarioId, {
                name: "missing-variable",
                description: "Missing variable",
                create: { User: [{ email: "{{owner_email}}" }] },
                validation: { status: "validated", method: "checkScenario", phase: "ok" },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenarioId)).rejects.toThrow("Unknown recipe variable: owner_email");
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("up: refuses to provision a stored recipe with an unused variable definition", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            const scenarioId = await harness.createScenario(orgId, appId, "unused-variable", {
                Organization: [{ name: "Acme Corp" }],
            });
            await harness.overwriteRecipeFixture(scenarioId, {
                name: "unused-variable",
                description: "Unused variable",
                create: { Organization: [{ name: "Acme Corp", note: "{{owner_email}}" }] },
                variables: {
                    owner_email: { strategy: "derived", source: "testRunId", format: "owner+{testRunId}@example.com" },
                    unused_token: { strategy: "literal", value: "never referenced" },
                },
                validation: { status: "validated", method: "checkScenario", phase: "ok" },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenarioId)).rejects.toThrow("Unused variable definition: unused_token");
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("up: fails clearly on unsupported faker generator", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            // The upload gate resolves the recipe, so a bad generator can only reach the DB by a direct write.
            const scenarioId = await harness.createScenario(orgId, appId, "bad-faker", {
                Organization: [{ name: "Acme Corp" }],
            });
            await harness.overwriteRecipeFixture(scenarioId, {
                name: "bad-faker",
                description: "Bad faker",
                create: { User: [{ email: "{{owner_email}}" }] },
                variables: { owner_email: { strategy: "faker", generator: "internet.userHandle" } },
                validation: { status: "validated", method: "checkScenario", phase: "ok" },
            });
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            await expect(manager.up(subject, scenarioId)).rejects.toThrow(
                "Unsupported faker generator: internet.userHandle",
            );
            expect(harness.webhookServer.requests).toHaveLength(0);
        });

        test("down: tears down instance and calls SDK endpoint", async ({
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

        test("down: marks instance as DOWN_FAILED when SDK call fails", async ({
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
