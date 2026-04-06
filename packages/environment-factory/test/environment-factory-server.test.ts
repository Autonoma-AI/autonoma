import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { EnvironmentFactoryServer } from "../src/environment-factory-server";

describe("EnvironmentFactoryServer", () => {
    it("discovers configured scenarios", async () => {
        const server = createServer();
        const result = await server.handle(createSignedRequest({ action: "discover" }));

        expect(result.status).toBe(200);
        expect(JSON.parse(result.body)).toEqual({
            environments: [
                {
                    description: "Default seeded data",
                    fingerprint: "fingerprint-standard",
                    name: "standard",
                },
                {
                    description: "Empty state data",
                    name: "empty",
                },
            ],
        });
    });

    it("creates an up response with an auto-signed refs token", async () => {
        const server = createServer();
        const result = await server.handle(
            createSignedRequest({
                action: "up",
                environment: "standard",
                testRunId: "run_123",
            }),
        );

        expect(result.status).toBe(200);
        const body = JSON.parse(result.body) as {
            auth: { headers: { Authorization: string } };
            expiresInSeconds: number;
            metadata: { role: string };
            refs: { organizationId: string };
            refsToken: string;
        };

        expect(body.auth.headers.Authorization).toBe("Bearer run_123");
        expect(body.expiresInSeconds).toBe(1200);
        expect(body.metadata).toEqual({ role: "admin" });
        expect(body.refs).toEqual({ organizationId: "org_run_123" });
        expect(body.refsToken.split(".")).toHaveLength(3);
    });

    it("routes down requests to the scenario encoded in the refs token", async () => {
        const down = vi.fn(async () => undefined);
        const server = createServer({ down });

        const upResponse = await server.handle(
            createSignedRequest({
                action: "up",
                environment: "standard",
                testRunId: "run_456",
            }),
        );
        const parsedUpResponse = JSON.parse(upResponse.body) as {
            refs: { organizationId: string };
            refsToken: string;
        };

        const downResponse = await server.handle(
            createSignedRequest({
                action: "down",
                refs: parsedUpResponse.refs,
                refsToken: parsedUpResponse.refsToken,
                testRunId: "run_456",
            }),
        );

        expect(downResponse.status).toBe(200);
        expect(JSON.parse(downResponse.body)).toEqual({ ok: true });
        expect(down).toHaveBeenCalledWith({
            refs: { organizationId: "org_run_456" },
            scenarioName: "standard",
            testRunId: "run_456",
        });
    });

    it("rejects invalid signatures", async () => {
        const server = createServer();
        const body = JSON.stringify({ action: "discover" });

        const result = await server.handle({
            headers: { "x-signature": "invalid" },
            method: "POST",
            rawBody: body,
        });

        expect(result.status).toBe(401);
        expect(JSON.parse(result.body)).toEqual({
            code: "INVALID_SIGNATURE",
            error: "Invalid or missing signature",
        });
    });

    it("returns 404 in production unless explicitly enabled", async () => {
        const server = createServer({ environment: "production" });
        const result = await server.handle(createSignedRequest({ action: "discover" }));

        expect(result.status).toBe(404);
        expect(result.body).toBe("");
    });

    it("rejects down requests whose refs do not match the token", async () => {
        const server = createServer();
        const upResponse = await server.handle(
            createSignedRequest({
                action: "up",
                environment: "standard",
                testRunId: "run_789",
            }),
        );
        const parsedUpResponse = JSON.parse(upResponse.body) as {
            refsToken: string;
        };

        const result = await server.handle(
            createSignedRequest({
                action: "down",
                refs: { organizationId: "org_tampered" },
                refsToken: parsedUpResponse.refsToken,
                testRunId: "run_789",
            }),
        );

        expect(result.status).toBe(403);
        expect(JSON.parse(result.body)).toEqual({
            code: "INVALID_REFS_TOKEN",
            error: "Refs token refs mismatch",
        });
    });

    it("supports fetch-style handlers", async () => {
        const server = createServer();
        const request = createSignedFetchRequest({ action: "discover" });

        const response = await server.handleRequest(request);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            environments: [
                {
                    description: "Default seeded data",
                    fingerprint: "fingerprint-standard",
                    name: "standard",
                },
                {
                    description: "Empty state data",
                    name: "empty",
                },
            ],
        });
    });
});

function createServer(params?: {
    allowInProduction?: boolean;
    down?: (context: { refs?: unknown; scenarioName: string; testRunId: string }) => Promise<void>;
    environment?: string;
}): EnvironmentFactoryServer {
    return new EnvironmentFactoryServer({
        allowInProduction: params?.allowInProduction,
        environment: params?.environment,
        internalSecret: "internal-secret",
        scenarios: [
            {
                description: "Default seeded data",
                fingerprint: ({ scenarioName }) => `fingerprint-${scenarioName}`,
                name: "standard",
                down: params?.down ?? (async () => undefined),
                up: async ({ testRunId }) => ({
                    auth: {
                        headers: {
                            Authorization: `Bearer ${testRunId}`,
                        },
                    },
                    expiresInSeconds: 1200,
                    metadata: {
                        role: "admin",
                    },
                    refs: {
                        organizationId: `org_${testRunId}`,
                    },
                }),
            },
            {
                description: "Empty state data",
                name: "empty",
                down: async () => undefined,
                up: async () => ({}),
            },
        ],
        sharedSecret: "shared-secret",
    });
}

function createSignedFetchRequest(body: unknown): Request {
    const rawBody = JSON.stringify(body);
    return new Request("https://example.com/api/autonoma", {
        body: rawBody,
        headers: {
            "content-type": "application/json",
            "x-signature": signBody(rawBody),
        },
        method: "POST",
    });
}

function createSignedRequest(body: unknown): {
    headers: Record<string, string>;
    method: string;
    rawBody: string;
} {
    const rawBody = JSON.stringify(body);
    return {
        headers: {
            "content-type": "application/json",
            "x-signature": signBody(rawBody),
        },
        method: "POST",
        rawBody,
    };
}

function signBody(rawBody: string): string {
    return createHmac("sha256", "shared-secret").update(rawBody).digest("hex");
}
