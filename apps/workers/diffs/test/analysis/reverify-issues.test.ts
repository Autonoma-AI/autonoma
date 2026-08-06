import { ApplicationArchitecture, type PrismaClient, applyMigrations, createClient } from "@autonoma/db";
import type { ReporterIssueKind, ReporterIssueStatus } from "@autonoma/diffs/analysis";
import { type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { expect } from "vitest";
import { type ReverifiedTest, reverifyOpenIssues } from "../../src/analysis/reverify-issues";
import { findOrCreateTestCase } from "./seed-generation";

const POSTGRES_IMAGE = "postgres:18-alpine";

/** Monotonic counter for unique org/app slugs across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

const logger = rootLogger.child({ name: "reverify-issues.test" });

interface SeededBranch {
    organizationId: string;
    applicationId: string;
    branchId: string;
    /** The run's own snapshot: `processing`, which is what the updater opens against. */
    runSnapshotId: string;
}

interface SeedIssueParams {
    title: string;
    /** The tests the issue covers - seeded as findings attributed to it, which is how the covered set is derived. */
    coveredSlugs: string[];
    /** How many earlier runs attributed the covered set to this issue: 2+ is a carried-forward issue. Defaults to 1. */
    carriedAcross?: number;
    kind?: ReporterIssueKind;
    status?: ReporterIssueStatus;
}

class ReverifyHarness implements IntegrationHarness {
    constructor(
        public readonly db: PrismaClient,
        private readonly pg: StartedPostgreSqlContainer,
    ) {}

    static async create(): Promise<ReverifyHarness> {
        const pg = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
        applyMigrations(pg.getConnectionUri());
        return new ReverifyHarness(createClient(pg.getConnectionUri()), pg);
    }

    async beforeAll() {}
    async afterAll() {
        await this.pg.stop();
    }
    async beforeEach() {}
    async afterEach() {}

    /** One application whose feature branch has a run in flight. */
    async seedBranch(): Promise<SeededBranch> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const application = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: ApplicationArchitecture.WEB,
            },
        });
        const branch = await this.db.branch.create({
            data: { name: `feat/branch-${n}`, applicationId: application.id, organizationId: org.id },
        });

        const runSnapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.id, source: "GITHUB_PUSH", status: "processing" },
        });

        return {
            organizationId: org.id,
            applicationId: application.id,
            branchId: branch.id,
            runSnapshotId: runSnapshot.id,
        };
    }

    /** Put a test in the run's suite, with a plan to generate against. */
    async assign(branch: SeededBranch, slug: string): Promise<string> {
        const testCaseId = await this.testCaseFor(branch, slug);
        const plan = await this.db.testPlan.create({
            data: { testCaseId, prompt: `${slug} plan`, organizationId: branch.organizationId },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: branch.runSnapshotId, testCaseId, planId: plan.id },
        });
        return plan.id;
    }

    /** Put a test in the run's suite with no plan assigned - there is nothing to queue a generation against. */
    async assignWithoutPlan(branch: SeededBranch, slug: string): Promise<void> {
        const testCaseId = await this.testCaseFor(branch, slug);
        await this.db.testCaseAssignment.create({ data: { snapshotId: branch.runSnapshotId, testCaseId } });
    }

    /** Put a test in the run set the way the diff-driven half of the stage does: a pending generation on the run. */
    async queueGeneration(branch: SeededBranch, planId: string): Promise<void> {
        await this.db.testGeneration.create({
            data: { testPlanId: planId, snapshotId: branch.runSnapshotId, organizationId: branch.organizationId },
        });
    }

    /**
     * An issue the branch already carries, with the covered set attributed to it on one earlier run per
     * `carriedAcross`. A finding is unique per (snapshot, test) and carries one `issueId`, so every run that
     * re-confirms an issue attributes its own findings - and a test covering two issues means one issue per run that
     * attributed it, which is why each run here gets its own snapshot.
     */
    async seedIssue(branch: SeededBranch, params: SeedIssueParams): Promise<string> {
        const issue = await this.db.analysisIssue.create({
            data: {
                branchId: branch.branchId,
                organizationId: branch.organizationId,
                title: params.title,
                kind: params.kind ?? "bug",
                severity: "high",
                status: params.status ?? "open",
                actualBehavior: `${params.title} misbehaves`,
                narrativeMarkdown: `${params.title} narrative`,
            },
        });

        for (let run = 0; run < (params.carriedAcross ?? 1); run += 1) {
            const priorSnapshot = await this.db.branchSnapshot.create({
                data: { branchId: branch.branchId, source: "GITHUB_PUSH", status: "superseded" },
            });
            // A finding FKs its run's AnalysisJob, so the earlier run's job has to exist before its findings do.
            await this.db.analysisJob.create({
                data: {
                    snapshotId: priorSnapshot.id,
                    organizationId: branch.organizationId,
                    status: "completed",
                    startedAt: new Date(),
                },
            });
            for (const slug of params.coveredSlugs) {
                // No classification: the covered set is the finding -> test relation, with no verdict in the way.
                await this.db.analysisFinding.create({
                    data: {
                        reportSnapshotId: priorSnapshot.id,
                        organizationId: branch.organizationId,
                        testCaseId: await this.testCaseFor(branch, slug),
                        issueId: issue.id,
                    },
                });
            }
        }
        return issue.id;
    }

    /** Run re-verification the way the Impact Analysis stage does, over the run's open updater. */
    async reverify(branch: SeededBranch): Promise<ReverifiedTest[]> {
        const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
            db: this.db,
            snapshotId: branch.runSnapshotId,
        });

        return await reverifyOpenIssues({ db: this.db, updater, logger });
    }

    /** The generations the run has queued, by the test each one will run. */
    async generationsOf(branch: SeededBranch): Promise<{ slug: string; status: string }[]> {
        const generations = await this.db.testGeneration.findMany({
            where: { snapshotId: branch.runSnapshotId },
            select: { status: true, testPlan: { select: { testCase: { select: { slug: true } } } } },
        });
        return generations.map((generation) => ({
            slug: generation.testPlan.testCase.slug,
            status: generation.status,
        }));
    }

    async queuedSlugs(branch: SeededBranch): Promise<string[]> {
        const generations = await this.generationsOf(branch);
        return generations.map((generation) => generation.slug).sort();
    }

    private async testCaseFor(branch: SeededBranch, slug: string): Promise<string> {
        return await findOrCreateTestCase(this.db, {
            applicationId: branch.applicationId,
            organizationId: branch.organizationId,
            slug,
        });
    }
}

integrationTestSuite({
    name: "reverifyOpenIssues (re-running the covering tests of a branch's open bugs)",
    createHarness: () => ReverifyHarness.create(),
    cases: (test) => {
        test("queues one generation for every test an open bug issue covers", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.assign(branch, "checkout");
            await harness.assign(branch, "cart");
            await harness.assign(branch, "untouched-by-any-issue");
            // Carried across three runs, so each covering test has three findings attributed to it - the covered set
            // is still the two tests, and each is queued once.
            await harness.seedIssue(branch, {
                title: "Checkout total is wrong",
                coveredSlugs: ["checkout", "cart"],
                carriedAcross: 3,
            });

            const reverified = await harness.reverify(branch);

            expect(reverified.map((test) => test.slug).sort()).toEqual(["cart", "checkout"]);
            // A pending generation is what makes each one a real investigation target rather than a silent write.
            const generations = await harness.generationsOf(branch);
            expect(generations.map((generation) => generation.slug).sort()).toEqual(["cart", "checkout"]);
            expect(generations.every((generation) => generation.status === "pending")).toBe(true);
            // The classifier is told which open issue put the test in the run set.
            expect(reverified[0]?.reason).toContain("Checkout total is wrong");
        });

        test("skips the covering tests the run already targets, keeping the rest of the covered set", async ({
            harness,
        }) => {
            const branch = await harness.seedBranch();
            await harness.assign(branch, "checkout");
            const cartPlanId = await harness.assign(branch, "cart");
            await harness.seedIssue(branch, { title: "Checkout total is wrong", coveredSlugs: ["checkout", "cart"] });
            // The diff selection got here first: `cart` already has this run's generation.
            await harness.queueGeneration(branch, cartPlanId);

            const reverified = await harness.reverify(branch);

            // Re-queueing `cart` would delete the generation the diff selection is holding, so only `checkout` is
            // added. The complete covered set still runs.
            expect(reverified.map((test) => test.slug)).toEqual(["checkout"]);
            expect(await harness.queuedSlugs(branch)).toEqual(["cart", "checkout"]);
        });

        test("drops a whole issue rather than re-verify it in part", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.assign(branch, "checkout");
            await harness.assignWithoutPlan(branch, "profile");
            // The suite no longer carries `retired`, so this issue's covered set cannot run in full.
            await harness.seedIssue(branch, {
                title: "Checkout total is wrong",
                coveredSlugs: ["checkout", "retired"],
            });
            // `profile` is assigned but planless, which is the same disqualification by another route.
            await harness.seedIssue(branch, { title: "Profile will not save", coveredSlugs: ["profile"] });
            // An issue no finding was ever attributed to covers nothing to re-run.
            await harness.seedIssue(branch, { title: "Reported with no covering test", coveredSlugs: [] });

            const reverified = await harness.reverify(branch);

            // Not even the covering test that IS available: an issue is re-verified in full or not at all, so the
            // Reporter is never handed a fraction of one issue's evidence.
            expect(reverified).toEqual([]);
            expect(await harness.queuedSlugs(branch)).toEqual([]);
        });

        test("re-verifies only open bug-kind issues", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.assign(branch, "checkout");
            await harness.assign(branch, "cart");
            await harness.assign(branch, "profile");
            await harness.seedIssue(branch, {
                title: "Checkout was fixed already",
                coveredSlugs: ["checkout"],
                status: "resolved",
            });
            await harness.seedIssue(branch, {
                title: "Preview environment is down",
                coveredSlugs: ["cart"],
                kind: "environment",
            });
            await harness.seedIssue(branch, {
                title: "Seed data has no orders",
                coveredSlugs: ["profile"],
                kind: "scenario",
            });

            const reverified = await harness.reverify(branch);

            // Neither an environment nor a scenario problem is a claim about the application, so passing the covering
            // test would settle nothing.
            expect(reverified).toEqual([]);
            expect(await harness.queuedSlugs(branch)).toEqual([]);
        });

        test("queues one generation for a test two open issues share, naming both", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.assign(branch, "checkout");
            await harness.assign(branch, "cart");
            await harness.seedIssue(branch, { title: "Checkout total is wrong", coveredSlugs: ["checkout"] });
            await harness.seedIssue(branch, { title: "Cart empties on reload", coveredSlugs: ["checkout", "cart"] });

            const reverified = await harness.reverify(branch);

            expect(reverified.map((test) => test.slug).sort()).toEqual(["cart", "checkout"]);
            expect(await harness.queuedSlugs(branch)).toEqual(["cart", "checkout"]);

            const checkout = reverified.find((test) => test.slug === "checkout");
            expect(checkout?.reason).toContain("Checkout total is wrong");
            expect(checkout?.reason).toContain("Cart empties on reload");
        });

        test("does nothing on a branch with no open bug issues", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.assign(branch, "checkout");

            expect(await harness.reverify(branch)).toEqual([]);
            expect(await harness.queuedSlugs(branch)).toEqual([]);
        });
    },
});
