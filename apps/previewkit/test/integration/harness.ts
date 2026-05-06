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
        await this.db.gitHubInstallation.deleteMany({});
        await this.db.organization.deleteMany({});
    }

    async afterEach() {}

    async createOrganization(): Promise<{ organizationId: string; slug: string }> {
        const slug = `test-org-${randomBytes(4).toString("hex")}`;
        const org = await this.db.organization.create({ data: { name: "Test Org", slug } });
        return { organizationId: org.id, slug };
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
