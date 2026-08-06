import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { revertSelfHealPlan } from "../../src/activities/analysis/revert-self-heal-plan";
import { selfHealAnalysisTest } from "../../src/activities/analysis/self-heal-test";

// Both activities read the `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it
// at this suite's container so they and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:18-alpine";
const ORIGINAL_PLAN = "1. Open checkout.\n2. Assert the total.";
const REVISED_PLAN = "1. Open checkout.\n2. Assert the label the app actually shows.";

/** Monotonic counter for unique slugs across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

interface SeededTest {
    snapshotId: string;
    slug: string;
    testCaseId: string;
    /** The plan the assignment points at before any self-heal. */
    planId: string;
}

class RevertHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<RevertHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        globalThis.prisma = db;
        return new RevertHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
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
        // status defaults to `processing`, which the TestSuiteUpdater path requires.
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH" },
        });
        const slug = `test-${n}`;
        const testCase = await this.db.testCase.create({
            data: { name: `Test ${n}`, slug, applicationId: app.id, folderId: folder.id, organizationId: org.id },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: ORIGINAL_PLAN, organizationId: org.id },
        });
        await this.db.testGeneration.create({
            data: { testPlanId: plan.id, snapshotId: snapshot.id, organizationId: org.id },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id },
        });
        return { snapshotId: snapshot.id, slug, testCaseId: testCase.id, planId: plan.id };
    }

    async assignedPlanId(snapshotId: string, testCaseId: string): Promise<string | undefined> {
        const assignment = await this.db.testCaseAssignment.findFirstOrThrow({
            where: { snapshotId, testCaseId },
            select: { planId: true },
        });
        return assignment.planId ?? undefined;
    }
}

integrationTestSuite({
    name: "revertSelfHealPlan (undoing a failed self-heal rewrite)",
    createHarness: () => RevertHarness.create(),
    cases: (test) => {
        // The whole point of reverting by plan ID: both change computations key on `planId`, not on the plan's text,
        // so re-authoring the original prompt as a NEW plan record would leave the test reading as modified with
        // identical before/after plans. Restoring the original ID is what makes the snapshot genuinely unchanged.
        test("restores the exact plan record the rewrite replaced, minting no new plan", async ({ harness }) => {
            const { snapshotId, slug, testCaseId, planId } = await harness.seedTest();

            const healed = await selfHealAnalysisTest({ snapshotId, slug, plan: REVISED_PLAN });
            if (!healed.prepared) throw new Error(`expected a prepared rewrite, got: ${healed.skippedReason}`);
            expect(healed.previousPlanId).toBe(planId);
            // The rewrite landed: the assignment now points at a different plan carrying the revised text.
            const healedPlanId = await harness.assignedPlanId(snapshotId, testCaseId);
            expect(healedPlanId).not.toBe(planId);
            const plansAfterHeal = await harness.db.testPlan.count({ where: { testCaseId } });

            const result = await revertSelfHealPlan({ snapshotId, slug, planId });

            expect(result.reverted).toBe(true);
            // Back to the ORIGINAL record - identity, not just matching text - so the snapshot is unchanged.
            expect(await harness.assignedPlanId(snapshotId, testCaseId)).toBe(planId);
            expect(await harness.db.testPlan.count({ where: { testCaseId } })).toBe(plansAfterHeal);
        });

        // `TestCaseAssignment.planId` is nullable, and the revert restores a plan BY ID - so a rewrite over an
        // assignment that pins no plan could never be undone, and a rewrite that then failed would promote. Self-heal
        // therefore refuses up front rather than leaving that trap for the revert to hit silently.
        test("refuses to rewrite an assignment that pins no plan, leaving it untouched", async ({ harness }) => {
            const { snapshotId, slug, testCaseId } = await harness.seedTest();
            await harness.db.testCaseAssignment.updateMany({
                where: { snapshotId, testCaseId },
                data: { planId: null },
            });

            const healed = await selfHealAnalysisTest({ snapshotId, slug, plan: REVISED_PLAN });

            expect(healed.prepared).toBe(false);
            // Nothing was authored: no new plan, and the assignment still pins none.
            expect(await harness.assignedPlanId(snapshotId, testCaseId)).toBeUndefined();
            expect(await harness.db.testPlan.count({ where: { testCaseId, prompt: REVISED_PLAN } })).toBe(0);
        });

        test("a slug with no assignment on the snapshot is a no-op reporting reverted:false", async ({ harness }) => {
            const { snapshotId, planId } = await harness.seedTest();

            const result = await revertSelfHealPlan({ snapshotId, slug: "not-a-real-slug", planId });

            expect(result.reverted).toBe(false);
            expect(result.reason).toBeDefined();
        });
    },
});
