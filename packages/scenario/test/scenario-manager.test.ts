import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { ScenarioManager } from "../src/scenario-manager";
import { GenerationSubject } from "../src/scenario-subject";
import { ScenarioTestHarness } from "./scenario-harness";

const SIGNING_SECRET = "test-secret";

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
        // discover tests need their own app because they assert on scenario counts
        test("discover: creates scenarios from webhook response", async ({
            harness,
            seedResult: { orgId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: {
                    environments: [
                        { name: "checkout", description: "Checkout flow", fingerprint: "abc123" },
                        { name: "login", description: "Login flow" },
                    ],
                },
            }));

            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });
            await manager.discover(appId, deploymentId);

            const scenarios = await harness.db.scenario.findMany({
                where: { applicationId: appId },
                orderBy: { name: "asc" },
            });
            expect(scenarios).toHaveLength(2);
            expect(scenarios[0]?.name).toBe("checkout");
            expect(scenarios[0]?.description).toBe("Checkout flow");
            expect(scenarios[0]?.lastSeenFingerprint).toBe("abc123");
            expect(scenarios[1]?.name).toBe("login");
        });

        test("discover: updates existing scenarios on re-discover", async ({
            harness,
            seedResult: { orgId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: {
                    environments: [{ name: "checkout", description: "Updated description", fingerprint: "v2" }],
                },
            }));

            const { appId, deploymentId } = await harness.createApp(orgId, {
                webhookUrl: harness.webhookServer.url,
                signingSecret: SIGNING_SECRET,
            });

            await harness.db.scenario.create({
                data: {
                    name: "checkout",
                    description: "Old description",
                    lastSeenFingerprint: "v1",
                    application: { connect: { id: appId } },
                    organization: { connect: { id: orgId } },
                },
            });

            await manager.discover(appId, deploymentId);

            const scenario = await harness.db.scenario.findUnique({
                where: { applicationId_name: { applicationId: appId, name: "checkout" } },
            });
            expect(scenario?.description).toBe("Updated description");
            expect(scenario?.lastSeenFingerprint).toBe("v2");
            expect(scenario?.fingerprintChangedAt).not.toBeNull();
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

            const scenarioId = await harness.createScenario(orgId, appId, "checkout");
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
                environment: "checkout",
            });

            // Verify the generation was linked to the instance
            const generation = await harness.db.testGeneration.findUniqueOrThrow({
                where: { id: generationId },
                select: { scenarioInstanceId: true },
            });
            expect(generation.scenarioInstanceId).toBe(instance.id);
        });

        test("up: marks instance as UP_FAILED when webhook fails", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 500,
                body: { error: "internal" },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "checkout-fail");
            const generationId = await harness.createGeneration(orgId, appId, deploymentId);
            const subject = new GenerationSubject(harness.db, generationId);

            const instance = await manager.up(subject, scenarioId);

            expect(instance.status).toBe("UP_FAILED");
            expect(instance.lastError).not.toBeNull();
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

        test("down: tears down instance and calls webhook", async ({
            harness,
            seedResult: { orgId, appId, deploymentId, manager },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { auth: {}, refs: { id: "r1" }, refsToken: "tok" },
            }));

            const scenarioId = await harness.createScenario(orgId, appId, "checkout-down");
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

            const scenarioId = await harness.createScenario(orgId, appId, "checkout-fail-down");
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
