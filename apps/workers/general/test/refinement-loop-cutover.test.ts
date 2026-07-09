import { type GenerationStatus, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type TestAPI, expect } from "vitest";
import { applyRemoveTest } from "../src/activities/healing/apply-remove-test";
import { applyReportBug } from "../src/activities/healing/apply-report-bug";
import { applyReportScenarioUnsupported } from "../src/activities/healing/apply-report-scenario-unsupported";
import { applyReportUnknownIssue } from "../src/activities/healing/apply-report-unknown-issue";
import { applyUpdatePlan } from "../src/activities/healing/apply-update-plan";
import { initRefinementLoop } from "../src/activities/refinement/loop-lifecycle";

// initRefinementLoop / applyRemoveTest / applyUpdatePlan / applyReportUnknownIssue /
// applyReportScenarioUnsupported read the `@autonoma/db` singleton (the global `db` proxy resolves
// to globalThis.prisma). Point it at this suite's container so the activities and the fixtures share
// one database.
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

    /** Mark a test case affected, optionally queuing a generation against its plan. */
    async createAffectedTest(args: {
        organizationId: string;
        snapshotId: string;
        testCaseId: string;
        planId?: string;
        generationStatus?: GenerationStatus;
    }): Promise<{ generationId?: string }> {
        let generationId: string | undefined;
        if (args.planId != null && args.generationStatus != null) {
            const generation = await this.db.testGeneration.create({
                data: {
                    testPlanId: args.planId,
                    snapshotId: args.snapshotId,
                    organizationId: args.organizationId,
                    status: args.generationStatus,
                },
                select: { id: true },
            });
            generationId = generation.id;
        }

        await this.db.affectedTest.create({
            data: {
                snapshotId: args.snapshotId,
                testCaseId: args.testCaseId,
                organizationId: args.organizationId,
                affectedReason: "code_change",
                reasoning: "touched by the diff",
                generationId,
            },
        });
        return { generationId };
    }

    async createPendingGeneration(args: {
        organizationId: string;
        snapshotId: string;
        planId: string;
        shadow?: boolean;
    }): Promise<void> {
        await this.db.testGeneration.create({
            data: {
                snapshotId: args.snapshotId,
                testPlanId: args.planId,
                organizationId: args.organizationId,
                shadow: args.shadow ?? false,
            },
        });
    }

    async branchIdOf(snapshotId: string): Promise<string> {
        const { branchId } = await this.db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: { branchId: true },
        });
        return branchId;
    }

    /** Another snapshot on an existing branch - a later commit of the same PR. */
    async createSnapshotOnBranch(branchId: string): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "GITHUB_PUSH" },
        });
        return snapshot.id;
    }

    /**
     * The detached investigation twin paired with a diffs snapshot. The twin lives
     * on the same branch as its parent (the feature branch), which is exactly what
     * a twin-detected bug must derive its branchId from.
     */
    async createInvestigationTwin(parentSnapshotId: string): Promise<string> {
        const branchId = await this.branchIdOf(parentSnapshotId);
        const twin = await this.db.branchSnapshot.create({ data: { branchId, source: "WEBHOOK" } });
        await this.db.branchSnapshot.update({
            where: { id: parentSnapshotId },
            data: { investigationSnapshotId: twin.id },
        });
        return twin.id;
    }

    /**
     * A failed generation review for a plan on a snapshot - the deterministic
     * failure metadata a report_bug action links its Issue to.
     */
    async createGenerationReview(args: {
        organizationId: string;
        snapshotId: string;
        planId: string;
    }): Promise<string> {
        const generation = await this.db.testGeneration.create({
            data: {
                snapshotId: args.snapshotId,
                testPlanId: args.planId,
                organizationId: args.organizationId,
                status: "failed",
            },
            select: { id: true },
        });
        const review = await this.db.generationReview.create({
            data: {
                generationId: generation.id,
                organizationId: args.organizationId,
                status: "completed",
                verdict: "application_bug",
            },
            select: { id: true },
        });
        return review.id;
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
    test("diffs init seeds iteration 1 from the affected + authored pending generations and fires the pipeline", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        // An affected test: analysis queued a pending generation from its committed plan.
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
            generationStatus: "pending",
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

        // Both affected and authored tests are just pending generations now, so
        // iteration 1's scope is their union and the pipeline fires.
        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([affected.planId, authored.planId].sort());
        expect(result.runFirstIterationPipeline).toBe(true);
    });

    test("init with no pending generations seeds nothing and skips the pipeline", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        // A plan-linked assignment but no pending generation for it.
        await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });

        const result = await initRefinementLoop({ snapshotId, triggeredBy: "diffs" });

        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([]);
        expect(result.runFirstIterationPipeline).toBe(false);
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

        // Both triggers seed identically from the snapshot's pending generations.
        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([a.planId, b.planId].sort());
        expect(result.runFirstIterationPipeline).toBe(true);
    });

    test("investigation shadow pending generations are invisible to loop init (no invariant break, not in scope)", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        const real = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: real.planId });

        // A shadow generation for the SAME plan would trip the "one pending generation per plan" invariant if
        // it were counted; a shadow generation for a DIFFERENT plan would wrongly enter iteration 1's scope.
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: real.planId, shadow: true });
        const shadowOnly = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
        });
        await harness.createPendingGeneration({ organizationId, snapshotId, planId: shadowOnly.planId, shadow: true });

        // Must not throw the duplicate-plan invariant, and iteration 1 sees only the real plan.
        const result = await initRefinementLoop({ snapshotId, triggeredBy: "onboarding" });

        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([real.planId]);
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

        // An affected test whose generation review failed: healing updates its
        // plan, which queues a regeneration. applyUpdatePlan must link the
        // AffectedTest row to that fresh generation.
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

        // report_* records the failure as an Issue but leaves the assignment in
        // place so the test re-runs next snapshot rather than being excluded.
        await harness.db.testCaseAssignment.findUniqueOrThrow({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId: subject.testCaseId } },
            select: { id: true },
        });
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

    test("report_scenario_unsupported records a Bug-less Issue and removes the test from the suite", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const subject = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });

        // The failed generation review the scenario_unsupported issue cites.
        const generation = await harness.db.testGeneration.create({
            data: { snapshotId, testPlanId: subject.planId, organizationId, status: "failed" },
            select: { id: true },
        });
        const review = await harness.db.generationReview.create({
            data: { generationId: generation.id, organizationId, status: "completed", verdict: "scenario_unsupported" },
            select: { id: true },
        });

        await applyReportScenarioUnsupported({
            snapshotId,
            organizationId,
            testCaseId: subject.testCaseId,
            title: "Refund flow needs a settled order",
            description:
                "No scenario seeds a settled order to refund. Proposed extension: add a settled order to the 'returning shopper' scenario.",
            severity: "medium",
            evidence: [],
            reviewLink: { generationReviewId: review.id },
        });

        const issue = await harness.db.issue.findFirstOrThrow({
            where: { generationReviewId: review.id },
            select: { id: true, kind: true, snapshotId: true, bugId: true },
        });
        // scenario_unsupported: snapshot-scoped, and never a customer-facing Bug.
        expect(issue.kind).toBe("scenario_unsupported");
        expect(issue.snapshotId).toBe(snapshotId);
        expect(issue.bugId).toBeNull();

        const bugCount = await harness.db.bug.count({ where: { applicationId } });
        expect(bugCount).toBe(0);

        // Unlike the other report_* actions, scenario_unsupported removes the test
        // from the suite: its assignment for this snapshot is dropped, so it does
        // not re-run until a human extends the scenario and re-adds it.
        const assignment = await harness.db.testCaseAssignment.findUnique({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId: subject.testCaseId } },
            select: { id: true },
        });
        expect(assignment).toBeNull();

        // The Issue survives the assignment deletion (it hangs off the generation
        // review, not the assignment), preserving the proposed extension.
        const issueStillPresent = await harness.db.issue.findUnique({ where: { id: issue.id }, select: { id: true } });
        expect(issueStillPresent).not.toBeNull();
    });

    test("report_bug stamps the new Bug with the detecting snapshot's branch and retains applicationId", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const branchId = await harness.branchIdOf(snapshotId);
        const subject = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        const reviewId = await harness.createGenerationReview({ organizationId, snapshotId, planId: subject.planId });

        await applyReportBug({
            snapshotId,
            organizationId,
            testCaseId: subject.testCaseId,
            title: "Checkout total is wrong",
            description: "The cart sums line items incorrectly when a coupon is applied.",
            severity: "high",
            evidence: [],
            reviewLink: { generationReviewId: reviewId },
        });

        const bug = await harness.db.bug.findFirstOrThrow({
            where: { branchId },
            select: { id: true, branchId: true, applicationId: true },
        });
        // Branch-scoped, but the denormalized applicationId is still stamped so
        // application-scoped reads keep working during the additive slice.
        expect(bug.branchId).toBe(branchId);
        expect(bug.applicationId).toBe(applicationId);

        // The Issue links to the same Bug, so the occurrence hangs off the branch too.
        const issue = await harness.db.issue.findFirstOrThrow({
            where: { generationReviewId: reviewId },
            select: { kind: true, bugId: true },
        });
        expect(issue.kind).toBe("application_bug");
        expect(issue.bugId).toBe(bug.id);
    });

    test("report_bug folds the grounded suspectedCause into the persisted Issue.report", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const subject = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        const reviewId = await harness.createGenerationReview({ organizationId, snapshotId, planId: subject.planId });

        await applyReportBug({
            snapshotId,
            organizationId,
            testCaseId: subject.testCaseId,
            title: "Coupon double-counts",
            description: "Applying a coupon subtracts the discount twice.",
            severity: "high",
            evidence: [],
            report: {
                expectedBehavior: "The coupon is subtracted once.",
                actualBehavior: "The coupon is subtracted twice.",
                narrativeMarkdown: "The order total ends up short by one coupon value.",
            },
            suspectedCause: {
                explanation: "applyCoupon runs inside a reducer that already subtracted the discount upstream.",
                codeReferences: [
                    {
                        file: "src/cart/total.ts",
                        lines: "42-58",
                        snippet: "total -= coupon.value; // already applied upstream",
                    },
                ],
            },
            reviewLink: { generationReviewId: reviewId },
        });

        const issue = await harness.db.issue.findFirstOrThrow({
            where: { generationReviewId: reviewId },
            select: { report: true },
        });

        // The healing text core and the grounded cause land in one report blob, and the
        // snippet rides along with its file:line so the guess stays verifiable.
        expect(issue.report?.actualBehavior).toBe("The coupon is subtracted twice.");
        expect(issue.report?.suspectedCause?.explanation).toContain("reducer");
        expect(issue.report?.suspectedCause?.codeReferences[0]?.file).toBe("src/cart/total.ts");
        expect(issue.report?.suspectedCause?.codeReferences[0]?.snippet).toContain("already applied upstream");
    });

    test("report_bug drops a suspectedCause that has no report to live in", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const subject = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        const reviewId = await harness.createGenerationReview({ organizationId, snapshotId, planId: subject.planId });

        await applyReportBug({
            snapshotId,
            organizationId,
            testCaseId: subject.testCaseId,
            title: "Legacy occurrence",
            description: "An occurrence whose action carried a cause but no customer-facing report.",
            severity: "medium",
            evidence: [],
            suspectedCause: {
                explanation: "Grounded, but with no report there is no Suspected cause section to render it.",
                codeReferences: [{ file: "src/legacy.ts" }],
            },
            reviewLink: { generationReviewId: reviewId },
        });

        // The cause has no home without a report (the section renders below the proven
        // case), so the whole report column stays null rather than persisting a partial.
        const issue = await harness.db.issue.findFirstOrThrow({
            where: { generationReviewId: reviewId },
            select: { report: true },
        });
        expect(issue.report).toBeNull();
    });

    test("report_bug on the investigation twin derives branchId from the twin's (feature) branch", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const parentSnapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const branchId = await harness.branchIdOf(parentSnapshotId);
        const twinSnapshotId = await harness.createInvestigationTwin(parentSnapshotId);

        // The plan/review live on the twin snapshot - the twin is where the
        // investigation agent detected the bug.
        const subject = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId: twinSnapshotId,
        });
        const reviewId = await harness.createGenerationReview({
            organizationId,
            snapshotId: twinSnapshotId,
            planId: subject.planId,
        });

        await applyReportBug({
            snapshotId: twinSnapshotId,
            organizationId,
            testCaseId: subject.testCaseId,
            title: "Session drops mid-flow",
            description: "The auth token is discarded after the first navigation.",
            severity: "critical",
            evidence: [],
            reviewLink: { generationReviewId: reviewId },
        });

        // The twin is detached from every branch pointer, but its branchId is the
        // feature branch - so the bug lands on the feature branch, not on a phantom.
        const bug = await harness.db.bug.findFirstOrThrow({ where: { branchId }, select: { branchId: true } });
        expect(bug.branchId).toBe(branchId);
    });

    test("report_bug matched to a same-branch Bug appends an occurrence instead of a new row", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const firstSnapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const branchId = await harness.branchIdOf(firstSnapshotId);
        const first = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId: firstSnapshotId,
        });
        const firstReviewId = await harness.createGenerationReview({
            organizationId,
            snapshotId: firstSnapshotId,
            planId: first.planId,
        });

        await applyReportBug({
            snapshotId: firstSnapshotId,
            organizationId,
            testCaseId: first.testCaseId,
            title: "Search returns no results",
            description: "The search index is never queried for two-word terms.",
            severity: "high",
            evidence: [],
            reviewLink: { generationReviewId: firstReviewId },
        });
        const bug = await harness.db.bug.findFirstOrThrow({ where: { branchId }, select: { id: true } });

        // A later commit on the SAME branch re-detects the same root cause; the
        // matcher hands applyReportBug the existing bug id.
        const laterSnapshotId = await harness.createSnapshotOnBranch(branchId);
        const laterReviewId = await harness.createGenerationReview({
            organizationId,
            snapshotId: laterSnapshotId,
            planId: first.planId,
        });

        await applyReportBug({
            snapshotId: laterSnapshotId,
            organizationId,
            testCaseId: first.testCaseId,
            title: "Search still returns no results",
            description: "Two-word search terms match nothing.",
            severity: "critical",
            evidence: [],
            matchedBugId: bug.id,
            reviewLink: { generationReviewId: laterReviewId },
        });

        // No second Bug row: the occurrence collapses into the existing one, and
        // the severity is bumped to the higher of the two reports.
        const bugs = await harness.db.bug.findMany({ where: { branchId }, select: { id: true, severity: true } });
        expect(bugs).toHaveLength(1);
        expect(bugs[0]?.severity).toBe("critical");
        // Both Issues attach to the one Bug.
        const occurrences = await harness.db.issue.count({ where: { bugId: bug.id } });
        expect(occurrences).toBe(2);
    });

    test("report_bug refuses to link a matched Bug from a different branch", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        // A bug already tracked on branch A.
        const branchASnapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const onA = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId: branchASnapshotId,
        });
        const reviewA = await harness.createGenerationReview({
            organizationId,
            snapshotId: branchASnapshotId,
            planId: onA.planId,
        });
        await applyReportBug({
            snapshotId: branchASnapshotId,
            organizationId,
            testCaseId: onA.testCaseId,
            title: "Bug on branch A",
            description: "Root cause seen on branch A.",
            severity: "medium",
            evidence: [],
            reviewLink: { generationReviewId: reviewA },
        });
        const branchABranchId = await harness.branchIdOf(branchASnapshotId);
        const bugOnA = await harness.db.bug.findFirstOrThrow({
            where: { branchId: branchABranchId },
            select: { id: true },
        });

        // A detection on a different branch B is fed that branch-A bug id (a match
        // that should never happen once dedup is branch-scoped). The write path is
        // the last line of defence: it refuses the cross-branch attachment.
        const branchBSnapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);
        const onB = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId: branchBSnapshotId,
        });
        const reviewB = await harness.createGenerationReview({
            organizationId,
            snapshotId: branchBSnapshotId,
            planId: onB.planId,
        });

        await expect(
            applyReportBug({
                snapshotId: branchBSnapshotId,
                organizationId,
                testCaseId: onB.testCaseId,
                title: "Same symptom on branch B",
                description: "Looks the same as the branch A bug.",
                severity: "medium",
                evidence: [],
                matchedBugId: bugOnA.id,
                reviewLink: { generationReviewId: reviewB },
            }),
        ).rejects.toThrow(/branch invariant/);
    });
});
