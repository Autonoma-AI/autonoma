import { integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { WebhookClient } from "../src/webhook-client";
import { ScenarioTestHarness } from "./scenario-harness";

const SIGNING_SECRET = "test-secret";

integrationTestSuite({
    name: "WebhookClient",
    createHarness: () => ScenarioTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const { appId } = await harness.createApp(orgId, {
            webhookUrl: harness.webhookServer.url,
            signingSecret: SIGNING_SECRET,
        });
        const client = new WebhookClient(harness.db, appId, harness.webhookServer.url, SIGNING_SECRET);
        return { orgId, appId, client };
    },
    cases: (test) => {
        test("discover: returns parsed response", async ({ harness, seedResult: { client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { environments: [{ name: "checkout", description: "Checkout flow" }] },
            }));

            const result = await client.discover();

            expect(result.environments).toHaveLength(1);
            expect(result.environments[0]?.name).toBe("checkout");
        });

        test("discover: sends signature header", async ({ harness, seedResult: { client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { environments: [] },
            }));

            await client.discover();

            expect(harness.webhookServer.requests).toHaveLength(1);
            const sigHeader = harness.webhookServer.requests[0]?.headers["x-signature"];
            expect(sigHeader).toMatch(/^[a-f0-9]+$/);
        });

        test("discover: logs webhook call to database", async ({ harness, seedResult: { appId, client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { environments: [] },
            }));

            await client.discover();

            const calls = await harness.db.webhookCall.findMany({ where: { applicationId: appId } });
            expect(calls).toHaveLength(1);
            expect(calls[0]?.action).toBe("DISCOVER");
            expect(calls[0]?.statusCode).toBe(200);
        });

        test("up: returns parsed response with auth and refs", async ({
            harness,
            seedResult: { orgId, appId, client },
        }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: {
                    auth: { token: "abc" },
                    refs: { userId: "u1" },
                    refsToken: "tok-1",
                    expiresInSeconds: 3600,
                },
            }));

            const instanceId = await harness.createScenarioInstance(orgId, appId, "checkout", "REQUESTED");

            const result = await client.up({
                instanceId,
                scenarioName: "checkout",
            });

            expect(result.auth).toEqual({ token: "abc" });
            expect(result.refs).toEqual({ userId: "u1" });
            expect(result.refsToken).toBe("tok-1");
            expect(result.expiresInSeconds).toBe(3600);
        });

        test("up: sends correct body", async ({ harness, seedResult: { orgId, appId, client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: {},
            }));

            const instanceId = await harness.createScenarioInstance(orgId, appId, "checkout-body", "REQUESTED");

            await client.up({ instanceId, scenarioName: "checkout-body" });

            expect(harness.webhookServer.requests[0]?.body).toMatchObject({
                action: "up",
                environment: "checkout-body",
            });
        });

        test("down: returns parsed response", async ({ harness, seedResult: { orgId, appId, client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { ok: true },
            }));

            const instanceId = await harness.createScenarioInstance(orgId, appId, "checkout-down", "UP_SUCCESS");

            const result = await client.down({
                instanceId,
                refs: { userId: "u1" },
                refsToken: "tok-1",
            });

            expect(result.ok).toBe(true);
        });

        test("down: sends refs and refsToken in body", async ({ harness, seedResult: { orgId, appId, client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { ok: true },
            }));

            const instanceId = await harness.createScenarioInstance(orgId, appId, "checkout-refs", "UP_SUCCESS");

            await client.down({
                instanceId,
                refs: { userId: "u1" },
                refsToken: "tok-1",
            });

            expect(harness.webhookServer.requests[0]?.body).toMatchObject({
                action: "down",
                refs: { userId: "u1" },
                refsToken: "tok-1",
            });
        });

        test("retries on server error and succeeds", async ({ harness, seedResult: { client } }) => {
            let callCount = 0;
            harness.webhookServer.onRequest(() => {
                callCount++;
                if (callCount === 1) {
                    return { status: 500, body: { error: "internal" } };
                }
                return { status: 200, body: { environments: [] } };
            });

            const result = await client.discover();

            expect(result.environments).toEqual([]);
            expect(callCount).toBe(2);
        });

        test("throws after exhausting retries", async ({ harness, seedResult: { client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 500,
                body: { error: "down" },
            }));

            await expect(client.discover()).rejects.toThrow("Webhook returned HTTP 500");
        });

        test("throws on invalid response shape", async ({ harness, seedResult: { client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: { invalid: true },
            }));

            await expect(client.discover()).rejects.toThrow("response validation failed");
        });

        test("logs failed attempts to database", async ({ harness, seedResult: { appId, client } }) => {
            let callCount = 0;
            harness.webhookServer.onRequest(() => {
                callCount++;
                if (callCount <= 1) {
                    return { status: 500, body: { error: "boom" } };
                }
                return { status: 200, body: { environments: [] } };
            });

            await client.discover();

            const calls = await harness.db.webhookCall.findMany({
                where: { applicationId: appId },
                orderBy: { createdAt: "asc" },
            });
            expect(calls).toHaveLength(2);
            expect(calls[0]?.statusCode).toBe(500);
            expect(calls[1]?.statusCode).toBe(200);
        });
    },
});
