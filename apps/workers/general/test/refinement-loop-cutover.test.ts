import { type PrismaClient, type RunStatus, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type TestAPI, expect } from "vitest";
import { applyRemoveTest } from "../src/activities/healing/apply-remove-test";
import { applyReportUnknownIssue } from "../src/activities/healing/apply-report-unknown-issue";
import { applyUpdatePlan } from "../src/activities/healing/apply-update-plan";
import { initRefinementLoop } from "../src/activities/refinement/loop-lifecycle";

// initRefinementLoop / applyRemoveTest / applyUpdatePlan / applyReportUnknownIssue read the
// `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma). Point it at
// this suite's container so the activities and the fixtures share one database.
declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const POSTGRES_IMAGE = "postgres:17-alpine";

/** Monotonic counter for unique slugs/names across the whole suite (one container). */
let seq = 0;
const next = () => seq++;

interface PlanWithAssignment {
    testCaseId: string;
    planId: string;
}

class CutoverHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<CutoverHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        // Route the global db proxy used by the activities under test.
        globalThis.prisma = db;
        return new CutoverHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    async createOrgAndApp(): Promise<{ organizationId: string; applicationId: string; folderId: string }> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: { name: `App ${n}`, slug: `app-${n}`, organizationId: org.id, architecture: "WEB" },
        });
        const folder = await this.db.folder.create({
            data: { name: "default", applicationId: app.id, organizationId: org.id },
        });
        return { organizationId: org.id, applicationId: app.id, folderId: folder.id };
    }

    /** A processing snapshot with a DiffsJob - the baseline a diffs-triggered loop reads. */
    async createSnapshotWithDiffsJob(organizationId: string, applicationId: string): Promise<string> {
        const branch = await this.db.branch.create({
            data: { name: `branch-${next()}`, organizationId, applicationId },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "MANUAL" },
        });
        await this.db.diffsJob.create({
            data: { snapshotId: snapshot.id, organizationId, status: "replaying" },
        });
        return snapshot.id;
    }

    async createPlanWithAssignment(args: {
        organizationId: string;
        applicationId: string;
        folderId: string;
        snapshotId: string;
    }): Promise<PlanWithAssignment> {
        const slug = `tc-${next()}`;
        const testCase = await this.db.testCase.create({
            data: {
                name: `Test ${slug}`,
                slug,
                applicationId: args.applicationId,
                folderId: args.folderId,
                organizationId: args.organizationId,
            },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: "do the thing", organizationId: args.organizationId },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: args.snapshotId, testCaseId: testCase.id, planId: plan.id },
        });
        return { testCaseId: testCase.id, planId: plan.id };
    }

    /** Mark a test case affected, optionally linking a replay run against its plan. */
    async createAffectedTest(args: {
        organizationId: string;
        snapshotId: string;
        testCaseId: string;
        planId?: string;
        runStatus?: RunStatus;
    }): Promise<{ runId?: string }> {
        let runId: string | undefined;
        if (args.planId != null && args.runStatus != null) {
            const assignment = await this.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: args.snapshotId, testCaseId: args.testCaseId } },
                select: { id: true },
            });
            const run = await this.db.run.create({
                data: {
                    assignmentId: assignment.id,
                    planId: args.planId,
                    organizationId: args.organizationId,
                    status: args.runStatus,
                },
                select: { id: true },
            });
            runId = run.id;
        }

        await this.db.affectedTest.create({
            data: {
                snapshotId: args.snapshotId,
                testCaseId: args.testCaseId,
                organizationId: args.organizationId,
                affectedReason: "code_change",
                reasoning: "touched by the diff",
                runId,
            },
        });
        return { runId };
    }

    async createPendingGeneration(args: { organizationId: string; snapshotId: string; planId: string }): Promise<void> {
        await this.db.testGeneration.create({
            data: { snapshotId: args.snapshotId, testPlanId: args.planId, organizationId: args.organizationId },
        });
    }

    async inputPlanIds(iterationId: string): Promise<string[]> {
        const inputs = await this.db.refinementIterationInput.findMany({
            where: { iterationId },
            select: { planId: true },
        });
        return inputs.map((i) => i.planId).sort();
    }
}

interface SeedResult {
    organizationId: string;
    applicationId: string;
    folderId: string;
}

type SuiteContext = { harness: CutoverHarness; seedResult: SeedResult };

function cutoverSuite(cases: (test: TestAPI<SuiteContext>) => void) {
    integrationTestSuite<CutoverHarness, SeedResult>({
        name: "refinement loop cut-over",
        createHarness: () => CutoverHarness.create(),
        seed: (harness) => harness.createOrgAndApp(),
        cases,
    });
}

cutoverSuite((test) => {
    test("diffs init seeds iteration 1 from affected-test replays; no new tests means no pipeline", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        const replayed = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
        });
        await harness.createAffectedTest({
            organizationId,
            snapshotId,
            testCaseId: replayed.testCaseId,
            planId: replayed.planId,
            runStatus: "failed",
        });

        // An affected test that never got a run (e.g. quarantined) must be left
        // out of the seed - it has neither a generation nor a run.
        const noRun = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        await harness.createAffectedTest({ organizationId, snapshotId, testCaseId: noRun.testCaseId });

        const result = await initRefinementLoop({ snapshotId, triggeredBy: "diffs" });

        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([replayed.planId]);
        // No new tests were authored, so the snapshot has no pending generations:
        // iter 1 only analyzes the replays that already ran, never fires the pipeline.
        expect(result.runFirstIterationPipeline).toBe(false);
    });

    test("diffs init seeds the diffs-authored new tests into iteration 1 and fires the pipeline", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        // An affected test whose replay already ran (no pending generation).
        const replayed = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
        });
        await harness.createAffectedTest({
            organizationId,
            snapshotId,
            testCaseId: replayed.testCaseId,
            planId: replayed.planId,
            runStatus: "failed",
        });

        // A test the diffs agent authored during analysis: a plan with a pending
        // generation but no affected-test row (it is brand new, not affected).
        const authored = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
        });
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: authored.planId });

        const result = await initRefinementLoop({ snapshotId, triggeredBy: "diffs" });

        // Iteration 1's scope is the union of the affected replay plan and the
        // authored test's plan; the pipeline fires because a pending generation exists.
        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([replayed.planId, authored.planId].sort());
        expect(result.runFirstIterationPipeline).toBe(true);
    });

    test("onboarding init seeds iteration 1 from pending generations and fires the pipeline", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        const a = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        const b = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: a.planId });
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: b.planId });

        const result = await initRefinementLoop({ snapshotId, triggeredBy: "onboarding" });

        // Onboarding still seeds from pending generations and fires the pipeline -
        // the opposite of the diffs branch above, which seeds replays and skips it.
        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([a.planId, b.planId].sort());
        expect(result.runFirstIterationPipeline).toBe(true);
    });

    test("remove_test drops the test from the suite for this snapshot", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        // A test the diffs agent authored that healing then judges invalid and
        // removes (citing the failed generation/run review). Removal revokes the
        // test's membership in this snapshot.
        const invalid = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });

        await applyRemoveTest({ snapshotId, testCaseId: invalid.testCaseId });

        const assignment = await harness.db.testCaseAssignment.findUnique({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId: invalid.testCaseId } },
            select: { snapshotId: true },
        });
        expect(assignment).toBeNull();
    });

    test("update_plan links the affected test to its queued regeneration", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        // An affected test whose replay failed: healing updates its plan, which
        // queues a regeneration. applyUpdatePlan must link the AffectedTest row to
        // that fresh generation (no first-turn reconciliation tail involved).
        const affected = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
        });
        await harness.createAffectedTest({
            organizationId,
            snapshotId,
            testCaseId: affected.testCaseId,
            planId: affected.planId,
            runStatus: "failed",
        });

        await applyUpdatePlan({
            snapshotId,
            organizationId,
            testCaseId: affected.testCaseId,
            newPrompt: "navigate to /settings and confirm the new toggle persists",
        });

        // applyUpdatePlan queues exactly one generation for the updated plan.
        const generation = await harness.db.testGeneration.findFirstOrThrow({
            where: { snapshotId, testPlan: { testCaseId: affected.testCaseId } },
            select: { id: true },
        });

        const linked = await harness.db.affectedTest.findUniqueOrThrow({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId: affected.testCaseId } },
            select: { generationId: true },
        });
        expect(linked.generationId).toBe(generation.id);
    });

    test("report_unknown_issue creates a Bug-less, snapshot-scoped Issue and keeps the test runnable", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const subject = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });

        // The failed generation review the unknown_issue cites.
        const generation = await harness.db.testGeneration.create({
            data: { snapshotId, testPlanId: subject.planId, organizationId, status: "failed" },
            select: { id: true },
        });
        const review = await harness.db.generationReview.create({
            data: { generationId: generation.id, organizationId, status: "completed", verdict: "unknown_issue" },
            select: { id: true },
        });

        await applyReportUnknownIssue({
            snapshotId,
            organizationId,
            testCaseId: subject.testCaseId,
            title: "Charge never completes",
            description: "Looks like a backend issue we cannot see in the checked-out code.",
            severity: "medium",
            evidence: [],
            reviewLink: { generationReviewId: review.id },
        });

        const issue = await harness.db.issue.findFirstOrThrow({
            where: { generationReviewId: review.id },
            select: { id: true, kind: true, snapshotId: true, bugId: true },
        });
        // unknown_issue: snapshot-scoped, and never a customer-facing Bug.
        expect(issue.kind).toBe("unknown_issue");
        expect(issue.snapshotId).toBe(snapshotId);
        expect(issue.bugId).toBeNull();

        const bugCount = await harness.db.bug.count({ where: { applicationId } });
        expect(bugCount).toBe(0);

        // The test is NOT excluded: report_* records the failure as an Issue but
        // leaves the assignment in place so the test re-runs next snapshot.
        const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId: subject.testCaseId } },
            select: { quarantineIssueId: true },
        });
        expect(assignment.quarantineIssueId).toBeNull();
    });

    test("a pending generation on the investigation twin does NOT trip the diffs loop's per-plan invariant", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        // The diffs agent authored a test with a pending generation on its own snapshot.
        const authored = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
        });
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: authored.planId });

        // The investigation agent, running on its OWN detached twin snapshot, created a shadow generation for
        // the SAME plan. Before the snapshot split this lived on the diffs snapshot and made pendingGenerationPlanIds
        // see two pending rows for one plan, throwing "Multiple pending generations…". On a separate snapshot it is
        // invisible to the diffs loop's snapshot-scoped query.
        const { branchId } = await harness.db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: { branchId: true },
        });
        const twin = await harness.db.branchSnapshot.create({ data: { branchId, source: "WEBHOOK" } });
        await harness.db.branchSnapshot.update({
            where: { id: snapshotId },
            data: { investigationSnapshotId: twin.id },
        });
        await harness.createPendingGeneration({ organizationId, snapshotId: twin.id, planId: authored.planId });

        // The diffs loop initializes without throwing, and seeds only its own snapshot's plan.
        const result = await initRefinementLoop({ snapshotId, triggeredBy: "diffs" });
        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([authored.planId]);
        expect(result.runFirstIterationPipeline).toBe(true);
    });
});
