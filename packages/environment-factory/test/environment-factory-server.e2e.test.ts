import { createHmac } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentFactoryServer } from "../src/environment-factory-server";

describe("EnvironmentFactoryServer E2E", () => {
    it("serves discover, up, and down over real HTTP", async () => {
        const down = vi.fn(async () => undefined);
        const harness = await createHarness({ down });

        try {
            const discoverResponse = await signedPost(harness.baseUrl, { action: "discover" });
            expect(discoverResponse.status).toBe(200);
            expect(await discoverResponse.json()).toEqual({
                environments: [
                    {
                        description: "Seeded organization with authenticated admin",
                        fingerprint: "fingerprint-standard",
                        name: "standard",
                    },
                ],
            });

            const upResponse = await signedPost(harness.baseUrl, {
                action: "up",
                environment: "standard",
                testRunId: "run_e2e",
            });
            expect(upResponse.status).toBe(200);
            const upBody = (await upResponse.json()) as {
                auth: { headers: { Authorization: string } };
                refs: { organizationId: string };
                refsToken: string;
            };
            expect(upBody.auth.headers.Authorization).toBe("Bearer run_e2e");
            expect(upBody.refs.organizationId).toBe("org_run_e2e");
            expect(upBody.refsToken).toMatch(/\./);

            const downResponse = await signedPost(harness.baseUrl, {
                action: "down",
                refs: upBody.refs,
                refsToken: upBody.refsToken,
                testRunId: "run_e2e",
            });
            expect(downResponse.status).toBe(200);
            expect(await downResponse.json()).toEqual({ ok: true });
            expect(down).toHaveBeenCalledWith({
                refs: { organizationId: "org_run_e2e" },
                scenarioName: "standard",
                testRunId: "run_e2e",
            });
        } finally {
            await harness.close();
        }
    });

    it("rejects invalid signatures over HTTP", async () => {
        const harness = await createHarness();

        try {
            const response = await fetch(harness.baseUrl, {
                body: JSON.stringify({ action: "discover" }),
                headers: {
                    "content-type": "application/json",
                    "x-signature": "invalid",
                },
                method: "POST",
            });

            expect(response.status).toBe(401);
            expect(await response.json()).toEqual({
                code: "INVALID_SIGNATURE",
                error: "Invalid or missing signature",
            });
        } finally {
            await harness.close();
        }
    });

    it("returns 404 over HTTP when disabled in production", async () => {
        const harness = await createHarness({ environment: "production" });

        try {
            const response = await signedPost(harness.baseUrl, { action: "discover" });

            expect(response.status).toBe(404);
            expect(await response.text()).toBe("");
        } finally {
            await harness.close();
        }
    });
});

async function createHarness(params?: {
    down?: (context: { refs?: unknown; scenarioName: string; testRunId: string }) => Promise<void>;
    environment?: string;
}): Promise<{ baseUrl: string; close(): Promise<void> }> {
    const environmentFactory = new EnvironmentFactoryServer({
        environment: params?.environment,
        internalSecret: "internal-secret",
        scenarios: [
            {
                description: "Seeded organization with authenticated admin",
                fingerprint: "fingerprint-standard",
                name: "standard",
                down: params?.down ?? (async () => undefined),
                up: async ({ testRunId }) => ({
                    auth: {
                        headers: {
                            Authorization: `Bearer ${testRunId}`,
                        },
                    },
                    expiresInSeconds: 300,
                    refs: {
                        organizationId: `org_${testRunId}`,
                    },
                }),
            },
        ],
        sharedSecret: "shared-secret",
    });

    const httpServer = createServer(async (request, response) => {
        await handleHttpRequest(environmentFactory, request, response);
    });

    httpServer.listen(0, "127.0.0.1");
    await once(httpServer, "listening");

    const address = httpServer.address();
    if (address == null || typeof address === "string") {
        throw new Error("Failed to resolve HTTP server address");
    }

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        async close(): Promise<void> {
            httpServer.close();
            await once(httpServer, "close");
        },
    };
}

async function handleHttpRequest(
    environmentFactory: EnvironmentFactoryServer,
    request: IncomingMessage,
    response: ServerResponse,
): Promise<void> {
    const rawBody = await readRawBody(request);
    const result = await environmentFactory.handle({
        headers: request.headers,
        method: request.method ?? "GET",
        rawBody,
    });

    response.writeHead(result.status, result.headers);
    response.end(result.body);
}

async function readRawBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    return Buffer.concat(chunks).toString("utf8");
}

async function signedPost(url: string, body: unknown): Promise<Response> {
    const rawBody = JSON.stringify(body);

    return fetch(url, {
        body: rawBody,
        headers: {
            "content-type": "application/json",
            "x-signature": createHmac("sha256", "shared-secret").update(rawBody).digest("hex"),
        },
        method: "POST",
    });
}
