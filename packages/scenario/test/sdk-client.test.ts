import { type IncomingMessage, type Server, createServer } from "node:http";
import { integrationTestSuite } from "@autonoma/integration-test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DbSdkCallRecorder } from "../src/db-sdk-call-recorder";
import { type SdkCallEvent, type SdkCallRecorder } from "../src/sdk-call-recorder";
import { SdkClient } from "../src/sdk-client";
import { ScenarioTestHarness } from "./scenario-harness";

const SIGNING_SECRET = "test-secret";

const DISCOVER_BODY = {
    schema: { models: [], edges: [], relations: [], scopeField: "organizationId" },
};

class InMemoryRecorder implements SdkCallRecorder {
    public readonly events: SdkCallEvent[] = [];

    async record(event: SdkCallEvent): Promise<void> {
        this.events.push(event);
    }
}

class TestServer {
    private readonly server: Server;
    private handler: (req: IncomingMessage, body: unknown) => { status: number; body: unknown } = () => ({
        status: 200,
        body: {},
    });
    public readonly requests: Array<{ method: string; body: unknown; headers: Record<string, string | undefined> }> =
        [];
    public port = 0;

    constructor() {
        this.server = createServer((req, res) => {
            this.readBody(req).then((body) => {
                this.requests.push({
                    method: req.method ?? "GET",
                    body,
                    headers: req.headers as Record<string, string | undefined>,
                });
                const result = this.handler(req, body);
                res.writeHead(result.status, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result.body));
            });
        });
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server.listen(0, () => {
                const addr = this.server.address();
                if (addr != null && typeof addr === "object") {
                    this.port = addr.port;
                }
                resolve();
            });
        });
    }

    get url(): string {
        return `http://localhost:${this.port}/sdk`;
    }

    onRequest(handler: (req: IncomingMessage, body: unknown) => { status: number; body: unknown }): void {
        this.handler = handler;
    }

    reset(): void {
        this.requests.length = 0;
        this.handler = () => ({ status: 200, body: {} });
    }

    async stop(): Promise<void> {
        return new Promise((resolve) => {
            this.server.close(() => resolve());
        });
    }

    private readBody(req: IncomingMessage): Promise<unknown> {
        return new Promise((resolve) => {
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => chunks.push(chunk));
            req.on("end", () => {
                const raw = Buffer.concat(chunks).toString("utf8");
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    resolve(raw);
                }
            });
        });
    }
}

// ---------------------------------------------------------------------------
// DB-free unit tests. Prove that SdkClient is constructible and exercisable
// without any Prisma / Postgres / harness dependency.
// ---------------------------------------------------------------------------

describe("SdkClient (DB-free)", () => {
    let server: TestServer;
    let recorder: InMemoryRecorder;
    let client: SdkClient;

    beforeAll(async () => {
        server = new TestServer();
        await server.start();
    });

    afterAll(async () => {
        await server.stop();
    });

    beforeEach(() => {
        server.reset();
        recorder = new InMemoryRecorder();
        client = new SdkClient({
            applicationId: "app-1",
            sdkUrl: server.url,
            signingSecret: SIGNING_SECRET,
            recorder,
        });
    });

    it("returns parsed discover response", async () => {
        server.onRequest(() => ({
            status: 200,
            body: {
                schema: {
                    models: [{ name: "User", fields: [] }],
                    edges: [],
                    relations: [],
                    scopeField: "organizationId",
                },
            },
        }));

        const result = await client.discover();

        expect(result.schema.models).toHaveLength(1);
        expect(result.schema.models[0]?.name).toBe("User");
    });

    it("signs the request body with HMAC-SHA256", async () => {
        server.onRequest(() => ({ status: 200, body: DISCOVER_BODY }));

        await client.discover();

        expect(server.requests).toHaveLength(1);
        const sigHeader = server.requests[0]?.headers["x-signature"];
        expect(sigHeader).toMatch(/^[a-f0-9]+$/);
    });

    it("forwards custom headers to the SDK endpoint", async () => {
        server.onRequest(() => ({ status: 200, body: DISCOVER_BODY }));

        const clientWithHeaders = new SdkClient({
            applicationId: "app-1",
            sdkUrl: server.url,
            signingSecret: SIGNING_SECRET,
            customHeaders: { "x-tenant": "acme" },
            recorder,
        });
        await clientWithHeaders.discover();

        expect(server.requests[0]?.headers["x-tenant"]).toBe("acme");
    });

    it("throws on a server error without retrying", async () => {
        let callCount = 0;
        server.onRequest(() => {
            callCount += 1;
            return { status: 500, body: { error: "down" } };
        });

        await expect(client.discover({ timeoutMs: 5_000 })).rejects.toThrow("SDK returned HTTP 500");
        expect(callCount).toBe(1);
    });

    it("throws on response validation failure", async () => {
        let callCount = 0;
        server.onRequest(() => {
            callCount += 1;
            return { status: 200, body: { invalid: true } };
        });

        await expect(client.discover({ timeoutMs: 5_000 })).rejects.toThrow("response validation failed");
        expect(callCount).toBe(1);
    });

    it("records exactly one event per call", async () => {
        server.onRequest(() => ({ status: 200, body: DISCOVER_BODY }));

        await client.discover({ timeoutMs: 5_000 });

        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0]?.statusCode).toBe(200);
        expect(recorder.events[0]?.action).toBe("DISCOVER");
    });

    it("records one event then throws on a failed call", async () => {
        server.onRequest(() => ({ status: 500, body: { error: "boom" } }));

        await expect(client.discover({ timeoutMs: 5_000 })).rejects.toThrow("SDK returned HTTP 500");
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0]?.statusCode).toBe(500);
    });

    it("does not defend against a recorder that rejects (recorder owns its own error handling)", async () => {
        const flakyRecorder: SdkCallRecorder = {
            record: async () => {
                throw new Error("recorder went down");
            },
        };
        const flakyClient = new SdkClient({
            applicationId: "app-1",
            sdkUrl: server.url,
            signingSecret: SIGNING_SECRET,
            recorder: flakyRecorder,
        });
        server.onRequest(() => ({ status: 200, body: DISCOVER_BODY }));

        // The recorder contract is "never rejects". A naively-implemented
        // recorder that rejects will surface the error, which is documented behavior.
        await expect(flakyClient.discover({ timeoutMs: 5_000 })).rejects.toThrow("recorder went down");
    });
});

// ---------------------------------------------------------------------------
// DB-backed integration tests. Cover the production logging path through
// DbSdkCallRecorder against a real Postgres container.
// ---------------------------------------------------------------------------

integrationTestSuite({
    name: "SdkClient (DbSdkCallRecorder)",
    createHarness: () => ScenarioTestHarness.create(),
    seed: async (harness) => {
        const orgId = await harness.createOrg();
        const { appId } = await harness.createApp(orgId, {
            webhookUrl: harness.webhookServer.url,
            signingSecret: SIGNING_SECRET,
        });
        const client = new SdkClient({
            applicationId: appId,
            sdkUrl: harness.webhookServer.url,
            signingSecret: SIGNING_SECRET,
            recorder: new DbSdkCallRecorder(harness.db),
        });
        return { orgId, appId, client };
    },
    cases: (test) => {
        test("logs successful discover to webhookCall table", async ({ harness, seedResult: { appId, client } }) => {
            harness.webhookServer.onRequest(() => ({
                status: 200,
                body: DISCOVER_BODY,
            }));

            await client.discover();

            const calls = await harness.db.webhookCall.findMany({ where: { applicationId: appId } });
            expect(calls).toHaveLength(1);
            expect(calls[0]?.action).toBe("DISCOVER");
            expect(calls[0]?.statusCode).toBe(200);
        });

        test("logs a failed call to webhookCall table then throws", async ({
            harness,
            seedResult: { appId, client },
        }) => {
            harness.webhookServer.onRequest(() => ({ status: 500, body: { error: "boom" } }));

            await expect(client.discover()).rejects.toThrow("SDK returned HTTP 500");

            const calls = await harness.db.webhookCall.findMany({
                where: { applicationId: appId },
                orderBy: { createdAt: "asc" },
            });
            expect(calls).toHaveLength(1);
            expect(calls[0]?.statusCode).toBe(500);
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
                create: { Organization: [{ _alias: "org1", name: "Acme Corp" }] },
            });

            expect(result.auth).toEqual({ token: "abc" });
            expect(result.refs).toEqual({ userId: "u1" });
            expect(result.refsToken).toBe("tok-1");
            expect(result.expiresInSeconds).toBe(3600);
        });

        test("down: returns parsed response and forwards refs/refsToken", async ({
            harness,
            seedResult: { orgId, appId, client },
        }) => {
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
            expect(harness.webhookServer.requests[0]?.body).toMatchObject({
                action: "down",
                refs: { userId: "u1" },
                refsToken: "tok-1",
            });
        });
    },
});
