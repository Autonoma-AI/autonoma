import {
    type GenerationReviewVerdict,
    type GenerationStatus,
    type PrismaClient,
    type ReviewStatus,
    applyMigrations,
    createClient,
} from "@autonoma/db";
import { type IntegrationHarness, integrationTestSuite, stopContainer } from "@autonoma/integration-test";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { type TestAPI, expect } from "vitest";
import { bucketIterationOutcomes } from "../src/refinement/bucket-iteration-outcomes";

const POSTGRES_IMAGE = "postgres:17-alpine";

/** Monotonic counter for unique slugs/names across the whole suite (one container). */
let seq = 0;
const next = () => seq++;

interface PlanWithAssignment {
    testCaseId: string;
    testCaseSlug: string;
    testCaseName: string;
    planId: string;
    planPrompt: string;
    assignmentId: string;
}

/**
 * Focused harness for {@link bucketIterationOutcomes}: it builds exactly the
 * generation/review graph an iteration needs. A generation passing its review is
 * the definition of "validated" - there is no replay step.
 */
class BucketerHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<BucketerHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        const db = createClient(pg.getConnectionUri());
        return new BucketerHarness(db, pg);
    }

    async beforeAll() {}
    async afterAll() {
        await stopContainer(this.pg);
    }
    async beforeEach() {}
    async afterEach() {}

    async createOrgAndApp(): Promise<{ organizationId: string; applicationId: string; folderId: string }> {
        const n = next();
        const org = await this.db.organization.create({
            data: { name: `Org ${n}`, slug: `org-${n}` },
        });
        const app = await this.db.application.create({
            data: { name: `App ${n}`, slug: `app-${n}`, organizationId: org.id, architecture: "WEB" },
        });
        const folder = await this.db.folder.create({
            data: { name: "default", applicationId: app.id, organizationId: org.id },
        });
        return { organizationId: org.id, applicationId: app.id, folderId: folder.id };
    }

    async createSnapshot(organizationId: string, applicationId: string): Promise<string> {
        const branch = await this.db.branch.create({
            data: { name: `branch-${next()}`, organizationId, applicationId },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "MANUAL" },
        });
        return snapshot.id;
    }

    /** Create a test case, a plan, and the snapshot assignment binding them. */
    async createPlanWithAssignment(args: {
        organizationId: string;
        applicationId: string;
        folderId: string;
        snapshotId: string;
        prompt: string;
    }): Promise<PlanWithAssignment> {
        const slug = `tc-${next()}`;
        const name = `Test ${slug}`;
        const testCase = await this.db.testCase.create({
            data: {
                name,
                slug,
                applicationId: args.applicationId,
                folderId: args.folderId,
                organizationId: args.organizationId,
            },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: args.prompt, organizationId: args.organizationId },
        });
        const assignment = await this.db.testCaseAssignment.create({
            data: { snapshotId: args.snapshotId, testCaseId: testCase.id, planId: plan.id },
        });
        return {
            testCaseId: testCase.id,
            testCaseSlug: slug,
            testCaseName: name,
            planId: plan.id,
            planPrompt: args.prompt,
            assignmentId: assignment.id,
        };
    }

    /** Create a TestGeneration for a plan, with an optional structured failure and review. */
    async createGeneration(args: {
        planId: string;
        snapshotId: string;
        organizationId: string;
        status: GenerationStatus;
        failure?: PrismaJson.GenerationFailure;
        shadow?: boolean;
        reviewStatus?: ReviewStatus;
        reviewVerdict?: GenerationReviewVerdict;
        reviewReasoning?: string;
    }): Promise<{ generationId: string; generationReviewId?: string }> {
        const generation = await this.db.testGeneration.create({
            data: {
                testPlanId: args.planId,
                snapshotId: args.snapshotId,
                organizationId: args.organizationId,
                status: args.status,
                failure: args.failure,
                shadow: args.shadow ?? false,
            },
        });
        if (args.reviewStatus == null) return { generationId: generation.id };

        const review = await this.db.generationReview.create({
            data: {
                generationId: generation.id,
                status: args.reviewStatus,
                verdict: args.reviewVerdict,
                reasoning: args.reviewReasoning,
                organizationId: args.organizationId,
            },
        });
        return { generationId: generation.id, generationReviewId: review.id };
    }

    /** Create a refinement loop + its first iteration, scoped to the given input plans. */
    async createIteration(args: { organizationId: string; snapshotId: string; planIds: string[] }): Promise<string> {
        const loop = await this.db.refinementLoop.create({
            data: { snapshotId: args.snapshotId, organizationId: args.organizationId, triggeredBy: "diffs" },
        });
        const iteration = await this.db.refinementIteration.create({
            data: { loopId: loop.id, number: 1 },
        });
        await this.db.refinementIterationInput.createMany({
            data: args.planIds.map((planId) => ({ iterationId: iteration.id, planId })),
        });
        return iteration.id;
    }
}

interface SeedResult {
    organizationId: string;
    applicationId: string;
    folderId: string;
}

type SuiteContext = { harness: BucketerHarness; seedResult: SeedResult };

function bucketerSuite(cases: (test: TestAPI<SuiteContext>) => void) {
    integrationTestSuite<BucketerHarness, SeedResult>({
        name: "bucketIterationOutcomes",
        createHarness: () => BucketerHarness.create(),
        seed: (harness) => harness.createOrgAndApp(),
        cases,
    });
}

bucketerSuite((test) => {
    test("buckets generations by review: passed -> validated, failed -> failuresAtGeneration", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshot(organizationId, applicationId);

        const passing = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "generate this test",
        });
        await harness.createGeneration({
            planId: passing.planId,
            snapshotId,
            organizationId,
            status: "success",
            reviewStatus: "completed",
            reviewVerdict: "success",
        });

        const failing = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "generate that the review rejects",
        });
        const { generationId, generationReviewId } = await harness.createGeneration({
            planId: failing.planId,
            snapshotId,
            organizationId,
            status: "success",
            reviewStatus: "completed",
            reviewVerdict: "plan_mismatch",
            reviewReasoning: "the generated flow diverged from the plan",
        });

        const iterationId = await harness.createIteration({
            organizationId,
            snapshotId,
            planIds: [passing.planId, failing.planId],
        });

        const outcomes = await bucketIterationOutcomes(harness.db, iterationId);

        // The review-passing generation validates; the rejected one lands in
        // failuresAtGeneration carrying its generation review.
        expect(outcomes.validatedTestCaseIds).toEqual([passing.testCaseId]);
        expect(outcomes.failuresAtGeneration).toEqual([
            {
                failureKey: generationId,
                testCaseId: failing.testCaseId,
                testCaseSlug: failing.testCaseSlug,
                testCaseName: failing.testCaseName,
                planId: failing.planId,
                planPrompt: failing.planPrompt,
                sourceId: generationId,
                sourceStatus: "success",
                verdictKind: "plan_mismatch",
                reviewReasoning: "the generated flow diverged from the plan",
                generationReviewId,
            },
        ]);
    });

    test("routes a scenario_setup generation failure to systemBlocked, not failuresAtGeneration", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshot(organizationId, applicationId);

        const blocked = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "generate against a down scenario environment",
        });
        const { generationId } = await harness.createGeneration({
            planId: blocked.planId,
            snapshotId,
            organizationId,
            status: "failed",
            failure: { kind: "scenario_setup", message: "scenario endpoint returned 404" },
        });

        const iterationId = await harness.createIteration({
            organizationId,
            snapshotId,
            planIds: [blocked.planId],
        });

        const outcomes = await bucketIterationOutcomes(harness.db, iterationId);

        // scenario_setup is an un-healable infra failure: it must leave the
        // healable buckets empty so the loop converges without invoking healing.
        expect(outcomes.validatedTestCaseIds).toEqual([]);
        expect(outcomes.failuresAtGeneration).toEqual([]);
        expect(outcomes.systemBlocked).toEqual([
            {
                failureKey: generationId,
                testCaseId: blocked.testCaseId,
                testCaseSlug: blocked.testCaseSlug,
                testCaseName: blocked.testCaseName,
                planId: blocked.planId,
                planPrompt: blocked.planPrompt,
                sourceId: generationId,
                sourceStatus: "failed",
                verdictKind: undefined,
                reviewReasoning: undefined,
                generationReviewId: undefined,
            },
        ]);
    });

    test("a mixed iteration heals the rejected generation and blocks the scenario_setup one", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshot(organizationId, applicationId);

        const healable = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "generate that the review rejects",
        });
        const { generationId: healableGenId, generationReviewId } = await harness.createGeneration({
            planId: healable.planId,
            snapshotId,
            organizationId,
            status: "success",
            reviewStatus: "completed",
            reviewVerdict: "application_bug",
            reviewReasoning: "the app under test regressed",
        });

        const blocked = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "generate that hit a down scenario environment",
        });
        const { generationId: blockedGenId } = await harness.createGeneration({
            planId: blocked.planId,
            snapshotId,
            organizationId,
            status: "failed",
            failure: { kind: "scenario_setup", message: "scenario endpoint returned 404" },
        });

        const iterationId = await harness.createIteration({
            organizationId,
            snapshotId,
            planIds: [healable.planId, blocked.planId],
        });

        const outcomes = await bucketIterationOutcomes(harness.db, iterationId);

        // The review-rejected generation stays healable; only the scenario_setup
        // one is routed out, so the loop still heals the genuine regression.
        expect(outcomes.failuresAtGeneration).toEqual([
            {
                failureKey: healableGenId,
                testCaseId: healable.testCaseId,
                testCaseSlug: healable.testCaseSlug,
                testCaseName: healable.testCaseName,
                planId: healable.planId,
                planPrompt: healable.planPrompt,
                sourceId: healableGenId,
                sourceStatus: "success",
                verdictKind: "application_bug",
                reviewReasoning: "the app under test regressed",
                generationReviewId,
            },
        ]);
        expect(outcomes.systemBlocked.map((f) => f.failureKey)).toEqual([blockedGenId]);
    });

    test("ignores investigation shadow generations when picking the latest generation per plan", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshot(organizationId, applicationId);

        const plan = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "a genuinely regressed test",
        });

        // The real generation is a healable engine_error failure.
        const { generationId: realGenId } = await harness.createGeneration({
            planId: plan.planId,
            snapshotId,
            organizationId,
            status: "failed",
            failure: { kind: "engine_error", message: "the engine threw mid-run" },
        });

        // A NEWER investigation shadow generation with a scenario_setup failure. If it were picked as the
        // latest generation for this plan, the outcome would route to systemBlocked (un-healable) instead of
        // failuresAtGeneration - bucketing off the internal A/B measurement instead of the real generation.
        await harness.createGeneration({
            planId: plan.planId,
            snapshotId,
            organizationId,
            status: "failed",
            failure: { kind: "scenario_setup", message: "scenario endpoint returned 404" },
            shadow: true,
        });

        const iterationId = await harness.createIteration({ organizationId, snapshotId, planIds: [plan.planId] });

        const outcomes = await bucketIterationOutcomes(harness.db, iterationId);

        // The real engine_error generation wins, so the plan stays healable and the shadow's scenario_setup
        // never routes it to systemBlocked.
        expect(outcomes.systemBlocked).toEqual([]);
        expect(outcomes.failuresAtGeneration.map((f) => f.failureKey)).toEqual([realGenId]);
    });

    test("throws when an input plan has no generation", async ({
        harness,
        seedResult: { organizationId, applicationId, folderId },
    }) => {
        const snapshotId = await harness.createSnapshot(organizationId, applicationId);
        const plan = await harness.createPlanWithAssignment({
            organizationId,
            applicationId,
            folderId,
            snapshotId,
            prompt: "orphan plan",
        });
        const iterationId = await harness.createIteration({ organizationId, snapshotId, planIds: [plan.planId] });

        await expect(bucketIterationOutcomes(harness.db, iterationId)).rejects.toThrow(/has no TestGeneration/);
    });
});
