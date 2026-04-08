import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ApplicationArchitecture } from "@autonoma/db";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";

type RecordedRequest = {
    headers: Record<string, string | string[] | undefined>;
    body: unknown;
};

async function startScenarioWebhookServer() {
    const requests: RecordedRequest[] = [];

    const server = createServer((req, res) => {
        let body = "";

        req.setEncoding("utf8");
        req.on("data", (chunk) => {
            body += chunk;
        });
        req.on("end", () => {
            const parsedBody = body.length > 0 ? (JSON.parse(body) as unknown) : undefined;
            requests.push({
                headers: req.headers,
                body: parsedBody,
            });

            const action = (parsedBody as { action?: string } | undefined)?.action;
            res.setHeader("Content-Type", "application/json");

            if (action === "discover") {
                res.end(
                    JSON.stringify({
                        environments: [
                            {
                                name: "standard",
                                description: "Default data set",
                                fingerprint: "abcd1234abcd1234",
                            },
                            {
                                name: "empty",
                                description: "No seed data",
                                fingerprint: "efgh5678efgh5678",
                            },
                        ],
                    }),
                );
                return;
            }

            res.end(JSON.stringify({ ok: true }));
        });
    });

    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();
    if (address == null || typeof address === "string") {
        throw new Error("Webhook server failed to bind to a TCP port");
    }

    return {
        requests,
        url: `http://127.0.0.1:${(address as AddressInfo).port}`,
        close: () =>
            new Promise<void>((resolve, reject) => {
                server.close((error) => {
                    if (error != null) {
                        reject(error);
                        return;
                    }

                    resolve();
                });
            }),
    };
}

apiTestSuite({
    name: "scenarios",
    seed: async () => ({}),
    cases: (test) => {
        test("configures a webhook and discovers scenarios from it", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Scenarios App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const webhook = await startScenarioWebhookServer();
            try {
                await harness.request().scenarios.configureWebhook({
                    applicationId: application.id,
                    webhookUrl: webhook.url,
                    signingSecret: "super-secret-signing-key",
                });

                const discovered = await harness.request().scenarios.discover({ applicationId: application.id });

                expect(discovered).toHaveLength(2);
                expect(discovered.map((scenario) => scenario.name)).toEqual(
                    expect.arrayContaining(["empty", "standard"]),
                );
                expect(webhook.requests[0]?.headers["x-signature"]).toBeDefined();
            } finally {
                await webhook.close();
            }
        });

        test("lists webhook calls after discovery", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Webhook Calls App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const webhook = await startScenarioWebhookServer();
            try {
                await harness.request().scenarios.configureWebhook({
                    applicationId: application.id,
                    webhookUrl: webhook.url,
                    signingSecret: "another-super-secret",
                });

                await harness.request().scenarios.discover({ applicationId: application.id });

                const calls = await harness.request().scenarios.listWebhookCalls({ applicationId: application.id });
                expect(calls[0]?.action).toBe("DISCOVER");
                expect(calls[0]?.statusCode).toBe(200);
            } finally {
                await webhook.close();
            }
        });

        test("lists instances for a discovered scenario", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Scenario Instances App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            const scenario = await harness.db.scenario.create({
                data: {
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                    name: `standard-${suffix}`,
                    description: "Default scenario",
                },
            });

            await harness.db.scenarioInstance.create({
                data: {
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                    scenarioId: scenario.id,
                    status: "UP_SUCCESS",
                },
            });

            const instances = await harness.request().scenarios.listInstances({ scenarioId: scenario.id });
            expect(instances).toHaveLength(1);
            expect(instances[0]?.scenarioId).toBe(scenario.id);
        });

        test("removes configured webhooks and associated scenarios", async ({ harness }) => {
            const suffix = randomUUID();
            const application = await harness.services.applications.createApplication({
                name: `Remove Webhook App ${suffix}`,
                organizationId: harness.organizationId,
                architecture: ApplicationArchitecture.WEB,
                url: "https://example.com",
                file: "s3://bucket/default-file.png",
            });

            await harness.request().scenarios.configureWebhook({
                applicationId: application.id,
                webhookUrl: "https://example.com/autonoma",
                signingSecret: "remove-webhook-secret",
            });

            await harness.db.scenario.create({
                data: {
                    applicationId: application.id,
                    organizationId: harness.organizationId,
                    name: `cleanup-${suffix}`,
                },
            });

            await harness.request().scenarios.removeWebhook({ applicationId: application.id });

            const updatedApplication = await harness.db.application.findUniqueOrThrow({
                where: { id: application.id },
                select: { webhookUrl: true, signingSecretEnc: true },
            });
            const scenarios = await harness.db.scenario.findMany({ where: { applicationId: application.id } });

            expect(updatedApplication.webhookUrl).toBeNull();
            expect(updatedApplication.signingSecretEnc).toBeNull();
            expect(scenarios).toHaveLength(0);
        });
    },
});
