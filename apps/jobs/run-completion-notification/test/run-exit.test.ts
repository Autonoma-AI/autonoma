import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import type { IntegrationHarness } from "@autonoma/integration-test";
import { integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, beforeEach, expect, vi } from "vitest";

let testDb: PrismaClient;

vi.mock("@autonoma/db", async (importOriginal) => {
    process.env["DATABASE_URL"] = "postgresql://placeholder:placeholder@localhost:5432/placeholder";
    const original = await importOriginal();
    const mod = original as Record<string, unknown>;
    return {
        ...mod,
        get db() {
            return testDb;
        },
    };
});

vi.mock("../src/env", () => ({
    env: {
        APP_URL: "https://app.autonoma.ai",
    },
}));

class NotificationTestHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pgContainer: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<NotificationTestHarness> {
        const pgContainer = await new PostgreSqlContainer("postgres:17-alpine").start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new NotificationTestHarness(db, pgContainer);
    }

    async beforeAll() {
        testDb = this.db;
    }
    async afterAll() {
        await this.pgContainer.stop();
    }
    async beforeEach() {}
    async afterEach() {}
}

interface SeedResult {
    orgId: string;
    appId: string;
    appSlug: string;
    branchName: string;
    runId: string;
}

async function seedRunWithNotification(
    db: PrismaClient,
    options: { runStatus: "success" | "failed"; reasoning?: string; slackEnabled?: boolean; webhookUrl?: string },
): Promise<SeedResult> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const org = await db.organization.create({
        data: { name: "Test Org", slug: `test-org-${suffix}` },
    });

    const app = await db.application.create({
        data: {
            name: `Test App ${suffix}`,
            slug: `test-app-${suffix}`,
            architecture: "WEB",
            organizationId: org.id,
        },
    });

    const branch = await db.branch.create({
        data: {
            name: "main",
            applicationId: app.id,
            organizationId: org.id,
        },
    });

    const snapshot = await db.branchSnapshot.create({
        data: {
            branchId: branch.id,
            source: "MANUAL",
        },
    });

    const testCase = await db.testCase.create({
        data: {
            name: "Login flow test",
            slug: `login-flow-${suffix}`,
            applicationId: app.id,
            organizationId: org.id,
        },
    });

    const assignment = await db.testCaseAssignment.create({
        data: {
            snapshotId: snapshot.id,
            testCaseId: testCase.id,
        },
    });

    const run = await db.run.create({
        data: {
            status: options.runStatus,
            reasoning: options.reasoning,
            assignmentId: assignment.id,
            organizationId: org.id,
            completedAt: new Date(),
        },
    });

    if (options.slackEnabled !== false) {
        await db.notificationConfig.create({
            data: {
                channel: "SLACK",
                enabled: true,
                slackWebhookUrl: options.webhookUrl ?? "https://hooks.slack.com/services/T00/B00/test",
                applicationId: app.id,
                organizationId: org.id,
            },
        });
    }

    return {
        orgId: org.id,
        appId: app.id,
        appSlug: app.slug,
        branchName: branch.name,
        runId: run.id,
    };
}

const mockFetch = vi.fn();

integrationTestSuite({
    name: "handleRunExit",
    createHarness: () => NotificationTestHarness.create(),
    cases: (test) => {
        beforeEach(() => {
            mockFetch.mockReset();
            mockFetch.mockResolvedValue({ ok: true, status: 200 });
            vi.stubGlobal("fetch", mockFetch);
        });

        afterEach(() => {
            vi.unstubAllGlobals();
        });

        test("sends Slack notification for failed run with reasoning", async ({ harness }) => {
            const { handleRunExit } = await import("../src/handlers/run-exit");
            const seed = await seedRunWithNotification(harness.db, {
                runStatus: "failed",
                reasoning: "Button not found",
            });

            await handleRunExit(seed.runId);

            expect(mockFetch).toHaveBeenCalledOnce();
            const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit];
            expect(url).toBe("https://hooks.slack.com/services/T00/B00/test");

            const body = JSON.parse(options.body as string);
            const allText = JSON.stringify(body);
            expect(allText).toContain("Test Failed");
            expect(allText).toContain("Login flow test");
            expect(allText).toContain("Test App");
            expect(allText).toContain("Button not found");
        });

        test("sends Slack notification for success run", async ({ harness }) => {
            const { handleRunExit } = await import("../src/handlers/run-exit");
            const seed = await seedRunWithNotification(harness.db, {
                runStatus: "success",
            });

            await handleRunExit(seed.runId);

            expect(mockFetch).toHaveBeenCalledOnce();
            const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
            const allText = JSON.stringify(body);
            expect(allText).toContain("Test Passed");
            expect(allText).not.toContain("Reasoning");
        });

        test("skips notification when no config exists", async ({ harness }) => {
            const { handleRunExit } = await import("../src/handlers/run-exit");
            const seed = await seedRunWithNotification(harness.db, {
                runStatus: "failed",
                slackEnabled: false,
            });

            await handleRunExit(seed.runId);

            expect(mockFetch).not.toHaveBeenCalled();
        });

        test("skips notification when config is disabled", async ({ harness }) => {
            const { handleRunExit } = await import("../src/handlers/run-exit");
            const seed = await seedRunWithNotification(harness.db, {
                runStatus: "failed",
                slackEnabled: false,
            });

            await harness.db.notificationConfig.create({
                data: {
                    channel: "SLACK",
                    enabled: false,
                    slackWebhookUrl: "https://hooks.slack.com/services/T00/B00/disabled",
                    applicationId: seed.appId,
                    organizationId: seed.orgId,
                },
            });

            await handleRunExit(seed.runId);

            expect(mockFetch).not.toHaveBeenCalled();
        });

        test("skips notification when run not found", async () => {
            const { handleRunExit } = await import("../src/handlers/run-exit");

            await handleRunExit("nonexistent-run-id");

            expect(mockFetch).not.toHaveBeenCalled();
        });

        test("constructs correct run URL", async ({ harness }) => {
            const { handleRunExit } = await import("../src/handlers/run-exit");
            const seed = await seedRunWithNotification(harness.db, {
                runStatus: "success",
            });

            await handleRunExit(seed.runId);

            const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
            const allText = JSON.stringify(body);
            expect(allText).toContain(`https://app.autonoma.ai/app/${seed.appSlug}/branch/main/runs/${seed.runId}`);
        });
    },
});
