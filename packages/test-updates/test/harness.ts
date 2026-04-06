import { type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type TestAPI, expect } from "vitest";
import type { GenerationProvider } from "../src/generation/generation-job-provider";
import { SnapshotDraft, type TestSuiteInfo } from "../src/snapshot-draft";
import { TestSuiteUpdater } from "../src/test-update-manager";

const POSTGRES_IMAGE = "postgres:17-alpine";

export class TestUpdatesHarness implements IntegrationHarness {
    public readonly db: PrismaClient;

    private pgContainer: StartedPostgreSqlContainer;

    constructor(db: PrismaClient, pgContainer: StartedPostgreSqlContainer) {
        this.db = db;
        this.pgContainer = pgContainer;
    }

    static async create(): Promise<TestUpdatesHarness> {
        const pgContainer = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pgContainer.getConnectionUri());
        const db = createClient(pgContainer.getConnectionUri());
        return new TestUpdatesHarness(db, pgContainer);
    }

    async beforeAll() {
        // No-op - harness is ready after create()
    }

    async afterAll() {
        await this.pgContainer.stop();
    }

    async beforeEach() {
        // No-op
    }

    async afterEach() {
        // No-op
    }

    async createOrg(): Promise<string> {
        const date = Date.now();
        const org = await this.db.organization.create({
            data: {
                name: `Test Org ${date}`,
                slug: `test-org-${date}`,
            },
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

    async createBranch(
        organizationId: string,
        applicationId: string,
        options?: { githubRef?: string; lastHandledSha?: string },
    ): Promise<string> {
        const date = Date.now();
        const branch = await this.db.branch.create({
            data: {
                name: `branch-${date}`,
                organizationId,
                applicationId,
                githubRef: options?.githubRef,
                lastHandledSha: options?.lastHandledSha,
            },
        });
        return branch.id;
    }

    private counter = 0;

    async createGitHubInstallation(organizationId: string): Promise<string> {
        const existing = await this.db.gitHubInstallation.findUnique({
            where: { organizationId },
            select: { id: true },
        });

        if (existing != null) return existing.id;

        this.counter++;
        const installation = await this.db.gitHubInstallation.create({
            data: {
                installationId: this.counter,
                organizationId,
                accountLogin: `account-${this.counter}`,
                accountId: this.counter,
                accountType: "Organization",
            },
        });
        return installation.id;
    }

    async createGitHubRepository(installationId: string, applicationId: string, fullName: string): Promise<string> {
        this.counter++;
        const repo = await this.db.gitHubRepository.create({
            data: {
                installationId,
                githubRepoId: this.counter,
                name: fullName.split("/")[1] ?? fullName,
                fullName,
                defaultBranch: "main",
                private: false,
                applicationId,
            },
        });
        return repo.id;
    }

    /** Creates a fresh branch and starts a new SnapshotDraft on it. */
    async startDraft(organizationId: string, applicationId: string): Promise<SnapshotDraft> {
        const branchId = await this.createBranch(organizationId, applicationId);
        return SnapshotDraft.start({ db: this.db, branchId });
    }

    /** Creates a fresh branch and starts a TestSuiteUpdater on it. */
    async startUpdater(
        organizationId: string,
        applicationId: string,
        options?: {
            jobProvider?: GenerationProvider;
        },
    ): Promise<TestSuiteUpdater> {
        const branchId = await this.createBranch(organizationId, applicationId);
        return TestSuiteUpdater.startUpdate({
            db: this.db,
            branchId,
            jobProvider: options?.jobProvider,
        });
    }
}

export function findTestCase(info: TestSuiteInfo, slug: string) {
    const tc = info.testCases.find((t) => t.slug === slug);
    expect(tc, `test case "${slug}" not found`).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    return tc!;
}

export function findSkill(info: TestSuiteInfo, slug: string) {
    const sk = info.skills.find((s) => s.slug === slug);
    expect(sk, `skill "${slug}" not found`).toBeDefined();
    // biome-ignore lint/style/noNonNullAssertion: asserted above
    return sk!;
}

interface SeedResult {
    organizationId: string;
    applicationId: string;
    branchId: string;
}

type TestUpdateSuiteContext = { harness: TestUpdatesHarness; seedResult: SeedResult };

interface TestUpdateSuiteParams {
    name: string;
    cases: (test: TestAPI<TestUpdateSuiteContext>) => void;
}

export function testUpdateSuite({ name, cases }: TestUpdateSuiteParams) {
    integrationTestSuite<TestUpdatesHarness, SeedResult>({
        name,
        createHarness: () => TestUpdatesHarness.create(),
        seed: async (harness) => {
            const organizationId = await harness.createOrg();
            const applicationId = await harness.createApp(organizationId);
            const branchId = await harness.createBranch(organizationId, applicationId);
            return { organizationId, applicationId, branchId };
        },
        cases,
    });
}
