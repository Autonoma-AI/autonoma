import { type PrismaClient, createClient } from "@autonoma/db";
import type { IntegrationHarness } from "@autonoma/integration-test";

export class OnboardingTestHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<OnboardingTestHarness> {
        const dbUrl = process.env.TEST_DATABASE_URL;
        if (dbUrl == null) {
            throw new Error(
                "TEST_DATABASE_URL must be set. Run via vitest.integration.config.ts which uses globalSetup to start containers.",
            );
        }
        const db = createClient(dbUrl);
        return new OnboardingTestHarness(db);
    }

    async beforeAll() {}

    async afterAll() {}

    async beforeEach() {}

    async afterEach() {}

    async createOrg(): Promise<string> {
        const date = Date.now();
        const org = await this.db.organization.create({
            data: { name: `Test Org ${date}`, slug: `test-org-${date}` },
        });
        return org.id;
    }

    async createApp(organizationId: string): Promise<string> {
        const date = Date.now();
        const app = await this.db.application.create({
            data: {
                name: `App ${date}`,
                slug: `app-${date}`,
                organizationId,
                architecture: "WEB",
            },
        });

        const branch = await this.db.branch.create({
            data: {
                name: "main",
                applicationId: app.id,
                organizationId,
            },
        });

        const deployment = await this.db.branchDeployment.create({
            data: {
                branchId: branch.id,
                organizationId,
                webDeployment: {
                    create: {
                        url: "https://placeholder.example.com",
                        file: "",
                        organizationId,
                    },
                },
            },
        });

        await this.db.branch.update({
            where: { id: branch.id },
            data: { deploymentId: deployment.id },
        });

        await this.db.application.update({
            where: { id: app.id },
            data: { mainBranchId: branch.id },
        });

        return app.id;
    }
}
