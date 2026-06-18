import { type PrismaClient, type RunStatus, applyMigrations, createClient } from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { logger as rootLogger } from "@autonoma/logger";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type TestAPI, expect } from "vitest";
import { applyUpdatePlan } from "../src/activities/healing/apply-update-plan";
import { reconcileFirstTurnOutcomes } from "../src/activities/healing/reconcile-first-turn";
import { initRefinementLoop } from "../src/activities/refinement/loop-lifecycle";

// initRefinementLoop / reconcileFirstTurnOutcomes / applyUpdatePlan read the
// `@autonoma/db` singleton (the global `db` proxy resolves to globalThis.prisma).
// Point it at this suite's container so the activities and the fixtures share one
// database.
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

    async createCandidate(args: { organizationId: string; snapshotId: string }): Promise<string> {
        const candidate = await this.db.testCandidate.create({
            data: {
                snapshotId: args.snapshotId,
                organizationId: args.organizationId,
                name: `Candidate ${next()}`,
                instruction: "cover the new behaviour",
                reasoning: "the diff adds an untested flow",
            },
        });
        return candidate.id;
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
    test("diffs init seeds iteration 1 from affected-test replays and counts candidates", async ({
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

        await harness.createCandidate({ organizationId, snapshotId });
        await harness.createCandidate({ organizationId, snapshotId });

        const result = await initRefinementLoop({ snapshotId, triggeredBy: "diffs" });

        expect(await harness.inputPlanIds(result.firstIterationId)).toEqual([replayed.planId]);
        // Diffs iter 1 reads replays that already ran; it never fires generation.
        expect(result.runFirstIterationPipeline).toBe(false);
        expect(result.firstIterationCandidateCount).toBe(2);
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

    test("first-turn tail decides every candidate", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshotWithDiffsJob(organizationId, applicationId);

        // A minted test case standing in for an accepted candidate's new test.
        const minted = await harness.createPlanWithAssignment({ organizationId, applicationId, folderId, snapshotId });
        const accepted = await harness.createCandidate({ organizationId, snapshotId });
        const rejected = await harness.createCandidate({ organizationId, snapshotId });
        const leftover = await harness.createCandidate({ organizationId, snapshotId });

        await reconcileFirstTurnOutcomes({
            snapshotId,
            acceptedCandidateLinks: [{ candidateId: accepted, testCaseId: minted.testCaseId }],
            rejectedCandidates: [{ candidateId: rejected, reasoning: "duplicate coverage" }],
            logger: rootLogger.child({ name: "reconcileFirstTurnOutcomes.test" }),
        });

        const candidates = await harness.db.testCandidate.findMany({
            where: { snapshotId },
            select: { id: true, status: true, acceptedTestCaseId: true, rejectionReasoning: true },
        });
        const byId = new Map(candidates.map((c) => [c.id, c]));
        expect(byId.get(accepted)).toMatchObject({ status: "accepted", acceptedTestCaseId: minted.testCaseId });
        expect(byId.get(rejected)).toMatchObject({ status: "rejected", rejectionReasoning: "duplicate coverage" });
        // Result-tool guarantees every candidate is decided; the bulk safety net
        // still rejects any that slipped through with no reasoning.
        expect(byId.get(leftover)).toMatchObject({ status: "rejected", rejectionReasoning: null });
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
});
