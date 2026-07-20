import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite, stopContainer } from "@autonoma/integration-test";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import type { TestAPI } from "vitest";

const POSTGRES_IMAGE = "postgres:17-alpine";

export class DiffsCallbackHarness implements IntegrationHarness {
    public readonly db: PrismaClient;

    private pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<DiffsCallbackHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new DiffsCallbackHarness(db, pgContainer);
    }

    async beforeAll() {}
    async afterAll() {
        await stopContainer(this.pgContainer);
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
        return app.id;
    }

    async createBranch(organizationId: string, applicationId: string): Promise<string> {
        const date = Date.now();
        const branch = await this.db.branch.create({
            data: {
                name: `branch-${date}`,
                organizationId,
                applicationId,
            },
        });
        return branch.id;
    }

    async createFolder(organizationId: string, applicationId: string): Promise<string> {
        const folder = await this.db.folder.create({
            data: { name: "default", applicationId, organizationId },
        });
        return folder.id;
    }

    /**
     * Creates a branch with a `processing` snapshot that has a test case assigned
     * (test case + plan + assignment). The snapshot is deliberately left open, not
     * finalized: this mirrors what the diffs analysis flow sees, since
     * `prepareAffectedTestGenerations` regenerates affected tests on the still-open
     * snapshot (via `continueUpdateBySnapshot`), which requires it to be pending.
     * Returns the branchId, snapshotId, and testCaseId for use in tests.
     */
    async setupBranchWithTest(
        organizationId: string,
        applicationId: string,
        testSlug: string,
        testName: string,
    ): Promise<{ branchId: string; snapshotId: string; testCaseId: string }> {
        const branchId = await this.createBranch(organizationId, applicationId);
        const folderId = await this.createFolder(organizationId, applicationId);

        const updater = await TestSuiteUpdater.startUpdate({ db: this.db, branchId });
        await updater.apply(
            new AddTest({ name: testName, description: `Test: ${testName}`, plan: "initial plan", folderId }),
        );

        const snapshotId = updater.snapshotId;
        await this.db.diffsJob.create({ data: { snapshotId, organizationId, status: "pending" } });

        const testCase = await this.db.testCase.findFirstOrThrow({ where: { slug: testSlug, applicationId } });
        return { branchId, snapshotId, testCaseId: testCase.id };
    }
}

interface SeedResult {
    organizationId: string;
    applicationId: string;
}

type DiffsCallbackSuiteContext = { harness: DiffsCallbackHarness; seedResult: SeedResult };

interface DiffsCallbackSuiteParams {
    name: string;
    cases: (test: TestAPI<DiffsCallbackSuiteContext>) => void;
}

export function diffsCallbackSuite({ name, cases }: DiffsCallbackSuiteParams) {
    integrationTestSuite<DiffsCallbackHarness, SeedResult>({
        name,
        createHarness: () => DiffsCallbackHarness.create(),
        seed: async (harness) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            return { organizationId, applicationId };
        },
        cases,
    });
}
