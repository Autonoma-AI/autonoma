import { once } from "node:events";
import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { EnvironmentFactoryServer } from "@autonoma/environment-factory";
import { describe, expect, it, vi } from "vitest";
import { WebhookClient } from "../src/webhook-client";

const SHARED_SECRET = "test-secret";

describe("EnvironmentFactory compatibility", () => {
    it("WebhookClient can discover, up, and down against EnvironmentFactoryServer", async () => {
        const harness = await EnvironmentFactoryCompatibilityHarness.create();

        try {
            const client = new WebhookClient(harness.db, "app_123", harness.url, SHARED_SECRET);

            const discoverResponse = await client.discover();
            expect(discoverResponse.environments).toEqual([
                {
                    description: "Default seeded data for compatibility testing",
                    fingerprint: "compat-v1",
                    name: "standard",
                },
            ]);

            const upResponse = await client.up({
                instanceId: "run_compat",
                scenarioName: "standard",
            });
            expect(upResponse.auth).toEqual({
                headers: {
                    Authorization: "Bearer run_compat",
                },
            });
            expect(upResponse.refs).toEqual({
                organizationId: "org_run_compat",
            });
            expect(upResponse.refsToken).toEqual(expect.any(String));

            const downResponse = await client.down({
                instanceId: "run_compat",
                refs: upResponse.refs,
                refsToken: upResponse.refsToken,
            });
            expect(downResponse).toEqual({ ok: true });
            expect(harness.downCalls).toEqual([
                {
                    refs: {
                        organizationId: "org_run_compat",
                    },
                    scenarioName: "standard",
                    testRunId: "run_compat",
                },
            ]);
            expect(harness.logWebhookCall).toHaveBeenCalledTimes(3);
        } finally {
            await harness.close();
        }
    });
});

class EnvironmentFactoryCompatibilityHarness {
    public readonly db: {
        webhookCall: {
            create: ReturnType<typeof vi.fn>;
        };
    };
    public readonly downCalls: Array<{ refs?: unknown; scenarioName: string; testRunId: string }> = [];

    private readonly server: Server;
    private port = 0;

    private constructor() {
        this.logWebhookCall = vi.fn(async () => undefined);
        this.db = {
            webhookCall: {
                create: this.logWebhookCall,
            },
        };

        const environmentFactory = new EnvironmentFactoryServer({
            internalSecret: "internal-secret",
            scenarios: [
                {
                    description: "Default seeded data for compatibility testing",
                    fingerprint: "compat-v1",
                    name: "standard",
                    down: async (context) => {
                        this.downCalls.push(context);
                        return { ok: true };
                    },
                    up: async ({ testRunId }) => ({
                        auth: {
                            headers: {
                                Authorization: `Bearer ${testRunId}`,
                            },
                        },
                        expiresInSeconds: 900,
                        refs: {
                            organizationId: `org_${testRunId}`,
                        },
                    }),
                },
            ],
            sharedSecret: SHARED_SECRET,
        });

        this.server = createServer(async (request, response) => {
            await this.handleRequest(environmentFactory, request, response);
        });
    }

    public readonly logWebhookCall: ReturnType<typeof vi.fn>;

    public static async create(): Promise<EnvironmentFactoryCompatibilityHarness> {
        const harness = new EnvironmentFactoryCompatibilityHarness();
        await harness.start();
        return harness;
    }

    public async close(): Promise<void> {
        this.server.close();
        await once(this.server, "close");
    }

    public get url(): string {
        return `http://127.0.0.1:${this.port}/webhook`;
    }

    private async handleRequest(
        environmentFactory: EnvironmentFactoryServer,
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        const rawBody = await this.readRawBody(request);
        const result = await environmentFactory.handle({
            headers: request.headers,
            method: request.method ?? "GET",
            rawBody,
        });

        response.writeHead(result.status, result.headers);
        response.end(result.body);
    }

    private async readRawBody(request: IncomingMessage): Promise<string> {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        return Buffer.concat(chunks).toString("utf8");
    }

    private async start(): Promise<void> {
        this.server.listen(0, "127.0.0.1");
        await once(this.server, "listening");

        const address = this.server.address();
        if (address == null || typeof address === "string") {
            throw new Error("Failed to resolve compatibility server address");
        }

        this.port = address.port;
    }
}
