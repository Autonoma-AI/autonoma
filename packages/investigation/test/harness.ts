import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:17-alpine";

/** A real-Postgres harness (Testcontainers + Prisma migrations) for the investigation data layer. */
export class InvestigationDbHarness implements IntegrationHarness {
    public readonly db: PrismaClient;

    private readonly pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<InvestigationDbHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new InvestigationDbHarness(db, pgContainer);
    }

    async beforeAll(): Promise<void> {}
    async afterAll(): Promise<void> {
        await this.pgContainer.stop();
    }
    async beforeEach(): Promise<void> {}
    async afterEach(): Promise<void> {}

    async createOrganization(): Promise<string> {
        const stamp = Date.now();
        const organization = await this.db.organization.create({
            data: { name: `Test Org ${stamp}`, slug: `test-org-${stamp}` },
        });
        return organization.id;
    }

    async createApplication(organizationId: string): Promise<{ id: string; slug: string }> {
        const slug = `app-${Date.now()}`;
        const application = await this.db.application.create({
            data: { name: `App ${slug}`, slug, organizationId, architecture: "WEB" },
        });
        return { id: application.id, slug };
    }

    /** Create a branch + snapshot with one assigned test case (via the real TestSuiteUpdater flow). */
    async setupTestCase(
        organizationId: string,
        applicationId: string,
        testSlug: string,
    ): Promise<{ branchId: string; snapshotId: string; testCaseId: string; assignmentId: string }> {
        const branch = await this.db.branch.create({
            data: { name: `branch-${Date.now()}`, organizationId, applicationId },
        });
        const folder = await this.db.folder.create({ data: { name: "default", applicationId, organizationId } });

        const updater = await TestSuiteUpdater.startUpdate({ db: this.db, branchId: branch.id });
        await updater.apply(
            new AddTest({
                name: testSlug,
                description: `Test: ${testSlug}`,
                plan: "initial plan",
                folderId: folder.id,
            }),
        );
        const snapshotId = updater.snapshotId;
        await this.db.testGeneration.updateMany({ where: { status: "pending" }, data: { status: "success" } });
        await updater.finalize();

        const testCase = await this.db.testCase.findFirstOrThrow({
            where: { applicationId },
            orderBy: { createdAt: "desc" },
        });
        // The generated slug is derived from the name; align our query slug with what was created.
        await this.db.testCase.update({ where: { id: testCase.id }, data: { slug: testSlug } });
        const assignment = await this.db.testCaseAssignment.findFirstOrThrow({
            where: { testCaseId: testCase.id },
            orderBy: { createdAt: "desc" },
        });
        return { branchId: branch.id, snapshotId, testCaseId: testCase.id, assignmentId: assignment.id };
    }

    async setSnapshotHeadSha(snapshotId: string, headSha: string): Promise<void> {
        await this.db.branchSnapshot.update({ where: { id: snapshotId }, data: { headSha } });
    }

    /**
     * Create (or reuse) a scenario and pin a recipe version to a snapshot with the given `create` graph. Used to
     * set up the recipe-merge tests: a scenario recipe on a snapshot, so forking/diffing/applying can be exercised.
     */
    async createScenarioRecipe(
        snapshotId: string,
        opts: {
            scenarioId: string;
            scenarioName: string;
            applicationId: string;
            organizationId: string;
            createGraph: Record<string, unknown>;
        },
    ): Promise<void> {
        await this.db.scenario.upsert({
            where: { id: opts.scenarioId },
            create: {
                id: opts.scenarioId,
                applicationId: opts.applicationId,
                organizationId: opts.organizationId,
                name: opts.scenarioName,
            },
            update: {},
        });
        const schema = await this.db.scenarioSchemaSnapshot.upsert({
            where: { applicationId_snapshotId: { applicationId: opts.applicationId, snapshotId } },
            create: {
                applicationId: opts.applicationId,
                snapshotId,
                structureJson: { models: {} },
                fingerprint: `schema-${snapshotId}`,
            },
            update: {},
            select: { id: true },
        });
        await this.db.scenarioRecipeVersion.create({
            data: {
                scenarioId: opts.scenarioId,
                snapshotId,
                schemaSnapshotId: schema.id,
                applicationId: opts.applicationId,
                organizationId: opts.organizationId,
                scenarioNameSnapshot: opts.scenarioName,
                fingerprint: `recipe-${snapshotId}`,
                validationStatus: "validated",
                validationMethod: "endpoint-up-down",
                validationPhase: "ok",
                fixtureJson: {
                    name: opts.scenarioName,
                    description: "seed for tests",
                    create: opts.createGraph,
                    validation: { status: "validated", method: "endpoint-up-down", phase: "ok" },
                },
            },
        });
    }

    /** The `create` graph pinned to a snapshot for a scenario, or undefined when no recipe version exists. */
    async recipeCreateGraph(snapshotId: string, scenarioId: string): Promise<Record<string, unknown> | undefined> {
        const version = await this.db.scenarioRecipeVersion.findUnique({
            where: { scenarioId_snapshotId: { scenarioId, snapshotId } },
            select: { fixtureJson: true },
        });
        return version?.fixtureJson.create;
    }

    async linkPullRequestToBranch(applicationId: string, branchId: string, prNumber: number): Promise<void> {
        await this.db.featureBranchInfo.create({ data: { branchId, applicationId, prNumber } });
    }

    /** Seed the deployed ("diffs") agent's job for a snapshot. */
    async createDiffsJob(
        snapshotId: string,
        organizationId: string,
        fields: {
            status?: "pending" | "analyzing" | "replaying" | "generating" | "completed" | "failed";
            analysisReasoning?: string;
            resolutionReasoning?: string;
            analysisConversationUrl?: string;
        },
    ): Promise<void> {
        await this.db.diffsJob.create({
            data: {
                snapshotId,
                organizationId,
                status: fields.status ?? "completed",
                analysisReasoning: fields.analysisReasoning,
                resolutionReasoning: fields.resolutionReasoning,
                analysisConversationUrl: fields.analysisConversationUrl,
            },
        });
    }

    /** Seed an affected-test row the deployed agent flagged on a snapshot. */
    async createAffectedTest(
        snapshotId: string,
        testCaseId: string,
        organizationId: string,
        fields: {
            affectedReason?: "code_change" | "merge_plan_imported" | "merge_conflict";
            reasoning?: string;
            runId?: string;
            generationId?: string;
        },
    ): Promise<void> {
        await this.db.affectedTest.create({
            data: {
                snapshotId,
                testCaseId,
                organizationId,
                affectedReason: fields.affectedReason ?? "code_change",
                reasoning: fields.reasoning ?? "flagged by the diffs agent",
                runId: fields.runId,
                generationId: fields.generationId,
            },
        });
    }

    async createRun(
        organizationId: string,
        assignmentId: string,
        status: "pending" | "running" | "success" | "failed",
        createdAt: Date,
        failure?: PrismaJson.RunFailure,
    ): Promise<string> {
        const run = await this.db.run.create({
            data:
                failure != null
                    ? { organizationId, assignmentId, status, createdAt, failure }
                    : { organizationId, assignmentId, status, createdAt },
        });
        return run.id;
    }
}

interface InvestigationSeed {
    organizationId: string;
    application: { id: string; slug: string };
}

type SuiteContext = { harness: InvestigationDbHarness; seedResult: InvestigationSeed };

export function investigationDbSuite(params: { name: string; cases: (test: TestAPI<SuiteContext>) => void }): void {
    integrationTestSuite<InvestigationDbHarness, InvestigationSeed>({
        name: params.name,
        createHarness: () => InvestigationDbHarness.create(),
        seed: async (harness) => {
            const organizationId = await harness.createOrganization();
            const application = await harness.createApplication(organizationId);
            return { organizationId, application };
        },
        cases: params.cases,
    });
}
