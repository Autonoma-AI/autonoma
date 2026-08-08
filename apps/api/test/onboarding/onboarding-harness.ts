import { type PrismaClient, SnapshotStatus, createClient } from "@autonoma/db";
import type { IntegrationHarness } from "@autonoma/integration-test";

/** Advisory-lock key that serializes seeded-preview number allocation across workers. */
const SEED_ALLOCATION_LOCK_KEY = 728413;

/** Seeded GitHub repository ids start above this, so they read as harness-made. */
const SEEDED_GITHUB_REPOSITORY_ID_FLOOR = 900000;

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

    /**
     * Makes the application's primary repository resolvable WITHOUT a GitHub
     * service: stamps a fresh `githubRepositoryId` and seeds one
     * `PreviewkitEnvironment` row carrying the full name, so
     * `resolvePrimaryRepository`'s DB fallback finds it. Saving a preview
     * config refuses to run against an unresolvable primary repo, so any test
     * that saves one calls this first.
     *
     * Both numbers are allocated from the database rather than from a
     * per-process counter, because vitest gives each test file its own worker
     * while every worker shares ONE database: two files seeding the same repo
     * name would each claim PR 1 and the second would trip the unique
     * `namespace` and `(repoFullName, prNumber)` constraints - a failure that
     * only shows up in the full suite. The advisory lock, held until the
     * transaction commits, serializes the read-then-insert against the other
     * workers so concurrent seeds cannot pick the same numbers.
     *
     * The repository id is allocated above BOTH tables' high-water mark, not
     * just the applications': an environment has no foreign key to an
     * application, so it outlives one that a test deletes. Reading only the
     * applications would hand the deleted app's id straight back out and point
     * the new seed at a surviving environment row.
     */
    async linkPreviewRepo(applicationId: string, organizationId: string, repoFullName: string): Promise<void> {
        await this.db.$transaction(async (tx) => {
            // Wrapped in a subquery because Prisma cannot deserialize the lock function's `void` column.
            await tx.$queryRaw`SELECT true AS locked FROM (SELECT pg_advisory_xact_lock(${SEED_ALLOCATION_LOCK_KEY})) AS lock_acquired`;

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
