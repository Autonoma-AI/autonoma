import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { deleteAnalysisTest } from "../../src/activities/analysis/delete-test";

// deleteAnalysisTest reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma).
// Point it at this suite's container so the activity and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:17-alpine";

/** Monotonic counter for unique slugs across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

interface SeededTest {
    snapshotId: string;
    slug: string;
    testCaseId: string;
}

class DeleteHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<DeleteHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new DeleteHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a detached processing snapshot with one test (TestCase + plan + assignment) assigned to it. */
    async seedTest(): Promise<SeededTest> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        const folder = await this.db.folder.create({
            data: { name: `folder-${n}`, applicationId: app.id, organizationId: org.id },
        });
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        // status defaults to `processing`, which the TestSuiteUpdater path (pre_existing delete) requires.
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH" },
        });
        const slug = `test-${n}`;
        const testCase = await this.db.testCase.create({
            data: { name: `Test ${n}`, slug, applicationId: app.id, folderId: folder.id, organizationId: org.id },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: "plan", organizationId: org.id },
        });
        await this.db.testGeneration.create({
            data: { testPlanId: plan.id, snapshotId: snapshot.id, organizationId: org.id },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id },
        });
        return { snapshotId: snapshot.id, slug, testCaseId: testCase.id };
    }
}

integrationTestSuite({
    name: "deleteAnalysisTest (row-local self-delete)",
    createHarness: () => DeleteHarness.create(),
    cases: (test) => {
        test("a proposed test's whole TestCase is removed (cascading its plan + generation)", async ({ harness }) => {
            const { snapshotId, slug, testCaseId } = await harness.seedTest();

            const result = await deleteAnalysisTest({ snapshotId, slug, origin: "proposed" });

            expect(result.deleted).toBe(true);
            // The this-run-only TestCase is gone entirely - no orphaned catalog row is left behind.
            expect(await harness.db.testCase.findUnique({ where: { id: testCaseId } })).toBeNull();
            expect(await harness.db.testCaseAssignment.count({ where: { snapshotId, testCaseId } })).toBe(0);
            expect(await harness.db.testPlan.count({ where: { testCaseId } })).toBe(0);
        });

        test("a pre-existing test loses only its assignment; the TestCase survives", async ({ harness }) => {
            const { snapshotId, slug, testCaseId } = await harness.seedTest();

            const result = await deleteAnalysisTest({ snapshotId, slug, origin: "pre_existing" });

            expect(result.deleted).toBe(true);
            expect(await harness.db.testCaseAssignment.count({ where: { snapshotId, testCaseId } })).toBe(0);
            // The global TestCase is a real suite member and must survive an assignment-only delete.
            expect(await harness.db.testCase.findUnique({ where: { id: testCaseId } })).not.toBeNull();
        });

        test("a slug with no assignment on the snapshot is a no-op reporting deleted:false", async ({ harness }) => {
            const { snapshotId } = await harness.seedTest();

            const result = await deleteAnalysisTest({ snapshotId, slug: "not-a-real-slug", origin: "pre_existing" });

            expect(result.deleted).toBe(false);
            expect(result.reason).toBeDefined();
        });
    },
});
