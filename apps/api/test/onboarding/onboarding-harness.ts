import { type PrismaClient, SnapshotStatus, createClient } from "@autonoma/db";
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

    /**
     * Create a scenario with an active recipe version so that
     * `WorkingState.startScenarioDryRun()` passes its recipe-count check.
     */
    async seedScenarioWithRecipe(
        applicationId: string,
        organizationId: string,
        scenarioName = `scenario-${Date.now()}`,
    ): Promise<void> {
        await this.db.$transaction(async (tx) => {
            const app = await tx.application.findUniqueOrThrow({
                where: { id: applicationId },
                select: { mainBranch: { select: { id: true } } },
            });
            const mainBranch = app.mainBranch;
            if (mainBranch == null) throw new Error("Application has no main branch");

            const snapshot = await tx.branchSnapshot.create({
                data: {
                    branchId: mainBranch.id,
                    source: "MANUAL",
                    status: SnapshotStatus.active,
                },
            });

            await tx.branch.update({
                where: { id: mainBranch.id },
                data: { activeSnapshotId: snapshot.id },
            });

            const schemaSnapshot = await tx.scenarioSchemaSnapshot.create({
                data: {
                    applicationId,
                    snapshotId: snapshot.id,
                    structureJson: { models: {} },
                    fingerprint: "test-fp",
                },
            });

            const scenario = await tx.scenario.create({
                data: { applicationId, organizationId, name: scenarioName },
            });

            const recipeVersion = await tx.scenarioRecipeVersion.create({
                data: {
                    scenarioId: scenario.id,
                    snapshotId: snapshot.id,
                    schemaSnapshotId: schemaSnapshot.id,
                    applicationId,
                    organizationId,
                    scenarioNameSnapshot: scenarioName,
                    fingerprint: "test-fp",
                    validationStatus: "validated",
                    validationMethod: "checkScenario",
                    validationPhase: "ok",
                    fixtureJson: { User: [{ _alias: "u1", name: "Test" }] },
                },
            });

            await tx.scenario.update({
                where: { id: scenario.id },
                data: { activeRecipeVersionId: recipeVersion.id },
            });
        });
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
