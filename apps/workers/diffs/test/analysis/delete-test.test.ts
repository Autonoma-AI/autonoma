import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { deleteAnalysisTest } from "../../src/activities/analysis/delete-test";

// The activity reads the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it at
// this suite's container so it and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const PLAN = "1. Open checkout.\n2. Assert the total.";

/** Monotonic counter for unique slugs across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

interface SeededTest {
    snapshotId: string;
    slug: string;
    testCaseId: string;
}

class DeleteHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<DeleteHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new DeleteHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** Seed a processing snapshot with one test (TestCase + plan + assignment) assigned to it. */
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
        // status defaults to `processing`, which reopening the snapshot requires.
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH" },
        });
        const slug = `test-${n}`;
        const testCase = await this.db.testCase.create({
            data: { name: `Test ${n}`, slug, applicationId: app.id, folderId: folder.id, organizationId: org.id },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: PLAN, organizationId: org.id },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id },
        });
        return { snapshotId: snapshot.id, slug, testCaseId: testCase.id };
    }

    async hasAssignment(snapshotId: string, testCaseId: string): Promise<boolean> {
        const assignment = await this.db.testCaseAssignment.findFirst({ where: { snapshotId, testCaseId } });
        return assignment != null;
    }
}

integrationTestSuite({
    name: "deleteAnalysisTest (removing an invalid_test)",
    createHarness: () => DeleteHarness.create(),
    cases: (test) => {
        // The removal drops the snapshot ASSIGNMENT (so the test disappears from the promoted suite) but keeps the
        // TestCase and its plan - the classification record of WHY it was removed must survive, and destroying the
        // TestCase would cascade it away.
        test("removes the assignment while preserving the TestCase and its plan", async ({ harness }) => {
            const { snapshotId, slug, testCaseId } = await harness.seedTest();
            expect(await harness.hasAssignment(snapshotId, testCaseId)).toBe(true);

            const result = await deleteAnalysisTest({ snapshotId, slug });

            expect(result.deleted).toBe(true);
            expect(await harness.hasAssignment(snapshotId, testCaseId)).toBe(false);
            // The record of the test - and so the WHY behind its removal - is untouched.
            expect(await harness.db.testCase.count({ where: { id: testCaseId } })).toBe(1);
            expect(await harness.db.testPlan.count({ where: { testCaseId } })).toBe(1);
        });

        test("a slug with no assignment on the snapshot is a no-op reporting deleted:false", async ({ harness }) => {
            const { snapshotId } = await harness.seedTest();

            const result = await deleteAnalysisTest({ snapshotId, slug: "not-a-real-slug" });

            expect(result.deleted).toBe(false);
            expect(result.reason).toBeDefined();
        });
    },
});
