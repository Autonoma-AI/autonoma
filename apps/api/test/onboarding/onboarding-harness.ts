import { type PrismaClient, SnapshotStatus, createClient } from "@autonoma/db";
import { type IntegrationHarness, createTestDatabase } from "@autonoma/integration-test";

/** Seeded GitHub repository ids start above this, so they read as harness-made. */
const SEEDED_GITHUB_REPOSITORY_ID_FLOOR = 900000;

export class OnboardingTestHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<OnboardingTestHarness> {
        const db = createClient(await createTestDatabase());
        return new OnboardingTestHarness(db);
    }

    async beforeAll() {}

    async afterAll() {
        await this.db.$disconnect();
    }

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

        // Both production creation paths insert this row, and onboarding reads are queries that no
        // longer create it. A harness that skipped it would exercise a state real applications are
        // not in. The one test that wants a row-less application deletes it explicitly.
        await this.db.onboardingState.create({ data: { applicationId: app.id } });

        return app.id;
    }

    /**
     * Gives an application a preview topology naming `appNames`, and answers with
     * name -> app row id. Secrets and app instances hang off the app row, so a test
     * seeding either needs the topology first.
     */
    async seedTopology(applicationId: string, appNames: readonly string[]): Promise<Map<string, string>> {
        const config = await this.db.previewkitConfig.upsert({
            where: { applicationId },
            create: { applicationId },
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

    /**
     * Makes the application's primary repository resolvable WITHOUT a GitHub
     * service: stamps a fresh `githubRepositoryId` and seeds one
     * `PreviewkitEnvironment` row carrying the full name, so
     * `resolvePrimaryRepository`'s DB fallback finds it. Saving a preview
     * config refuses to run against an unresolvable primary repo, so any test
     * that saves one calls this first.
     *
     * Both numbers are allocated from the database rather than from a
     * per-process counter, so repeated seeds within a suite cannot collide on
     * the unique `namespace` or `(repoFullName, prNumber)` constraints.
     *
     * The repository id is allocated above BOTH tables' high-water mark, not
     * just the applications': an environment has no foreign key to an
     * application, so it outlives one that a test deletes. Reading only the
     * applications would hand the deleted app's id straight back out and point
     * the new seed at a surviving environment row.
     */
    async linkPreviewRepo(applicationId: string, organizationId: string, repoFullName: string): Promise<void> {
        await this.db.$transaction(async (tx) => {
            const [environments, applications, seededEnvironments] = await Promise.all([
                tx.previewkitEnvironment.aggregate({ where: { repoFullName }, _max: { prNumber: true } }),
                tx.application.aggregate({ _max: { githubRepositoryId: true } }),
                tx.previewkitEnvironment.aggregate({ _max: { githubRepositoryId: true } }),
            ]);

            const prNumber = (environments._max.prNumber ?? 0) + 1;
            const highestRepositoryId = Math.max(
                applications._max.githubRepositoryId ?? 0,
                seededEnvironments._max.githubRepositoryId ?? 0,
                SEEDED_GITHUB_REPOSITORY_ID_FLOOR,
            );
            const githubRepositoryId = highestRepositoryId + 1;
            const repoSlug = repoFullName.replace(/[^a-z0-9]+/gi, "-").toLowerCase();

            await tx.application.update({
                where: { id: applicationId },
                data: { githubRepositoryId },
            });
            await tx.previewkitEnvironment.create({
                data: {
                    namespace: `preview-seed-${repoSlug}-pr-${prNumber}`,
                    repoFullName,
                    prNumber,
                    headSha: "seed000",
                    headRef: "main",
                    githubRepositoryId,
                    organizationId,
                },
            });
        });
    }
}
