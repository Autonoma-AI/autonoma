import { randomBytes } from "node:crypto";
import { db } from "@autonoma/db";
import type { IntegrationHarness } from "@autonoma/integration-test";

export class PreviewkitTestHarness implements IntegrationHarness {
    public readonly db = db;

    static async create(): Promise<PreviewkitTestHarness> {
        if (process.env.TEST_DATABASE_URL == null) {
            throw new Error(
                "TEST_DATABASE_URL must be set. Run via vitest.integration.config.ts which boots Postgres via globalSetup.",
            );
        }
        return new PreviewkitTestHarness();
    }

    async beforeAll() {}

    async afterAll() {}

    async beforeEach() {
        // Per-test isolation: clear Previewkit tables (cascade handles children)
        // and the installations/orgs we create per test.
        await this.db.previewkitEnvironment.deleteMany({});
        await this.db.gitHubPrComment.deleteMany({});
        await this.db.gitHubInstallation.deleteMany({});
        await this.db.organization.deleteMany({});

        // Secret values went with their organizations above. The key rows are standalone,
        // and the values' Restrict FK to them means they can only go afterwards.
        await this.db.previewkitEncryptionKey.deleteMany({});
    }

    async afterEach() {}

    async createOrganization(): Promise<{ organizationId: string; slug: string }> {
        const slug = `test-org-${randomBytes(4).toString("hex")}`;
        const org = await this.db.organization.create({ data: { name: "Test Org", slug } });
        return { organizationId: org.id, slug };
    }

    /**
     * Gives an application a preview topology naming `appNames`, creating the
     * Application if `githubRepositoryId` has none.
     *
     * Not optional scaffolding: an app instance and an app build both hang off the
     * app row now, so a deploy has nowhere to record itself for an app the topology
     * does not name. Seeding it is what makes these tests exercise the real write.
     */
    async createTopology(
        organizationId: string,
        githubRepositoryId: number,
        appNames: readonly string[],
    ): Promise<Map<string, string>> {
        const application = await this.db.application.upsert({
            where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId } },
            create: {
                name: `App ${randomBytes(3).toString("hex")}`,
                slug: `app-${randomBytes(4).toString("hex")}`,
                organizationId,
                architecture: "WEB",
                githubRepositoryId,
            },
            update: {},
            select: { id: true },
        });
        const config = await this.db.previewkitConfig.upsert({
            where: { applicationId: application.id },
            create: { applicationId: application.id },
            update: {},
            select: { id: true },
        });

        const ids = new Map<string, string>();
        for (const [position, name] of appNames.entries()) {
            const app = await this.db.previewkitApp.upsert({
                where: { configId_name: { configId: config.id, name } },
                create: {
                    configId: config.id,
                    position,
                    name,
                    repository: "acme/web",
                    path: ".",
                    port: 3000,
                    resourcesCpu: "250m",
                    resourcesMemory: "1Gi",
                },
                update: {},
                select: { id: true },
            });
            ids.set(name, app.id);
        }
        return ids;
    }

    async createInstallationForOwner(owner: string): Promise<string> {
        const { organizationId } = await this.createOrganization();
        await this.db.gitHubInstallation.create({
            data: {
                installationId: Math.floor(Math.random() * 1_000_000_000),
                organizationId,
                accountLogin: owner,
                accountId: Math.floor(Math.random() * 1_000_000_000),
                accountType: "Organization",
            },
        });
        return organizationId;
    }
}
