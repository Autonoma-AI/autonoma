import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import type { PullRequest } from "@autonoma/github";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { TestSuiteStore } from "@autonoma/test-suite";
import { expect } from "vitest";
import { runMergeFlow } from "../../src/analysis/merge-flow";

const execFileAsync = promisify(execFile);

const MAIN_BRANCH_REF = "main";
const PR_NUMBER = 77;
const FEATURE_HEAD_SHA = "feature-head-sha";

/** Monotonic counter for unique slugs across the suite (one shared container, no per-test truncation). */
let seq = 0;
const next = () => seq++;

/**
 * The plan prose each leg of the merge holds. The classifier compares plan *ids*, so what these say only matters for
 * asserting WHICH version won - but the branch's text is what an import must copy onto main.
 */
const PLAN_AT_BASE = "1. Open checkout.\n2. Assert the total.";
const PLAN_ON_MAIN = "1. Open checkout.\n2. Assert the total, in main's wording.";
const PLAN_ON_BRANCH = "1. Open checkout.\n2. Assert the total the PR renamed.";

/** The slugs of the merge scenario, one per outcome the flow has to reach. */
interface MergeScenario {
    applicationId: string;
    targetSnapshotId: string;
    /** Main's plan sits at the merge base, the branch changed it -> imported via `revisePlan`. */
    imported: SeededTest;
    /** Authored on the branch, absent from main -> imported via `adoptTest`, same TestCase. */
    authored: SeededTest;
    /** Existed at base, branch removed it, main untouched -> propagated via `dropTest`. */
    deleted: SeededTest;
    /** Branch removed it but main modified it since base -> modify wins, the deletion is dropped. */
    keptOverDeletion: SeededTest;
    /** Both sides changed it -> a pre-classified conflict for the agent. */
    conflicting: SeededTest;
    /** Nobody changed it -> untouched, and never generated. */
    untouched: SeededTest;
}

interface SeededTest {
    slug: string;
    testCaseId: string;
    /** The plan main assigned before the merge flow ran, if any. */
    planIdOnMain?: string;
    /** The plan the feature branch assigned, if any. */
    planIdOnBranch?: string;
}

/** A stub of the one GitHub read merge detection performs: the PRs associated with a commit. */
function stubPullRequests(mergeCommitSha: string): { getAssociatedPullRequests: () => Promise<PullRequest[]> } {
    const pullRequest: PullRequest = {
        number: PR_NUMBER,
        title: "Rename the checkout total",
        headRef: "feat/checkout-copy",
        headSha: FEATURE_HEAD_SHA,
        baseRef: MAIN_BRANCH_REF,
        baseSha: "irrelevant",
        url: "https://github.test/pr/77",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        state: "merged",
        commitsCount: 1,
        merged: true,
        mergedAt: "2026-07-02T00:00:00Z",
        mergeCommitSha,
    };
    return { getAssociatedPullRequests: async () => [pullRequest] };
}

class MergeFlowHarness implements IntegrationHarness {
    /** A real two-commit repo, so the commit range and the ancestry check run against actual git. */
    public repoDir = "";
    public baseSha = "";
    public headSha = "";

    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<MergeFlowHarness> {
        const connectionUri = await createTestDatabase();
        return new MergeFlowHarness(createClient(connectionUri));
    }

    async beforeAll() {
        this.repoDir = await mkdtemp(path.join(tmpdir(), "merge-flow-"));
        await this.git("init", "--quiet");
        await this.git("config", "user.email", "test@autonoma.app");
        await this.git("config", "user.name", "Merge Flow Test");
        await this.git("commit", "--allow-empty", "--quiet", "-m", "main at the last analyzed head");
        this.baseSha = await this.revParse();
        await this.git("commit", "--allow-empty", "--quiet", "-m", `Merge pull request #${PR_NUMBER}`);
        this.headSha = await this.revParse();
    }

    async afterAll() {
        await rm(this.repoDir, { recursive: true, force: true });
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    private async git(...args: string[]): Promise<string> {
        const { stdout } = await execFileAsync("git", ["-C", this.repoDir, ...args]);
        return stdout;
    }

    private async revParse(): Promise<string> {
        return (await this.git("rev-parse", "HEAD")).trim();
    }

    /**
     * Seed one application whose main branch has a merged PR to absorb: a base snapshot shared as the merge base, a
     * `processing` snapshot on main (the run's own), and the PR branch's active snapshot pinned at its head SHA.
     */
    async seedMergeScenario(): Promise<MergeScenario> {
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
        const folder = await this.db.folder.create({
            data: { name: `folder-${n}`, applicationId: application.id, organizationId: org.id },
        });

        const mainBranch = await this.db.branch.create({
            data: { name: MAIN_BRANCH_REF, applicationId: application.id, organizationId: org.id },
        });
        await this.db.application.update({
            where: { id: application.id },
            data: { mainBranchId: mainBranch.id },
        });

        const baseSnapshotId = await this.createSnapshot(mainBranch.id, { status: "superseded" });
        const targetSnapshotId = await this.createSnapshot(mainBranch.id, { status: "processing" });

        const featureBranch = await this.db.branch.create({
            data: {
                name: "feat/checkout-copy",
                applicationId: application.id,
                organizationId: org.id,
                baseSnapshotId,
            },
        });
        const featureSnapshotId = await this.createSnapshot(featureBranch.id, {
            status: "active",
            headSha: FEATURE_HEAD_SHA,
        });
        await this.db.branch.update({
            where: { id: featureBranch.id },
            data: { activeSnapshotId: featureSnapshotId },
        });
        await this.db.featureBranchInfo.create({
            data: { applicationId: application.id, branchId: featureBranch.id, prNumber: PR_NUMBER },
        });

        const seedTest = async (
            name: string,
            legs: { base: boolean; main?: string; branch?: string },
        ): Promise<SeededTest> => {
            const slug = `${name}-${n}`;
            const testCase = await this.db.testCase.create({
                data: {
                    name: `${name} ${n}`,
                    slug,
                    applicationId: application.id,
                    folderId: folder.id,
                    organizationId: org.id,
                },
            });
            const mintPlan = async (prompt: string) => {
                const plan = await this.db.testPlan.create({
                    data: { testCaseId: testCase.id, prompt, organizationId: org.id },
                });
                return plan.id;
            };

            const planIdAtBase = legs.base ? await mintPlan(PLAN_AT_BASE) : undefined;
            if (planIdAtBase != null) await this.assign(baseSnapshotId, testCase.id, planIdAtBase);

            // A leg reusing the base's plan text is unchanged, and must reuse its plan RECORD: the classifier reads
            // divergence off the plan id.
            const planIdOnMain =
                legs.main == null
                    ? undefined
                    : legs.main === PLAN_AT_BASE && planIdAtBase != null
                      ? planIdAtBase
                      : await mintPlan(legs.main);
            if (planIdOnMain != null) await this.assign(targetSnapshotId, testCase.id, planIdOnMain);

            const planIdOnBranch =
                legs.branch == null
                    ? undefined
                    : legs.branch === PLAN_AT_BASE && planIdAtBase != null
                      ? planIdAtBase
                      : await mintPlan(legs.branch);
            if (planIdOnBranch != null) await this.assign(featureSnapshotId, testCase.id, planIdOnBranch);

            return { slug, testCaseId: testCase.id, planIdOnMain, planIdOnBranch };
        };

        return {
            applicationId: application.id,
            targetSnapshotId,
            imported: await seedTest("imported", { base: true, main: PLAN_AT_BASE, branch: PLAN_ON_BRANCH }),
            authored: await seedTest("authored", { base: false, branch: PLAN_ON_BRANCH }),
            deleted: await seedTest("deleted", { base: true, main: PLAN_AT_BASE }),
            keptOverDeletion: await seedTest("kept-over-deletion", { base: true, main: PLAN_ON_MAIN }),
            conflicting: await seedTest("conflicting", {
                base: true,
                main: PLAN_ON_MAIN,
                branch: PLAN_ON_BRANCH,
            }),
            untouched: await seedTest("untouched", { base: true, main: PLAN_AT_BASE, branch: PLAN_AT_BASE }),
        };
    }

    /** Run the merge flow the way the Impact Analysis stage does on a main-branch run. */
    async runFlow(scenario: MergeScenario, overrides: { baseSha?: string } = {}) {
        const store = new TestSuiteStore(this.db);
        const snapshot = await store.reopen(scenario.targetSnapshotId);

        return await runMergeFlow({
            db: this.db,
            store,
            snapshot,
            githubClient: stubPullRequests(this.headSha),
            owner: "autonoma",
            repo: "app",
            targetBranchRef: MAIN_BRANCH_REF,
            baseSha: overrides.baseSha ?? this.baseSha,
            headSha: this.headSha,
            repoDir: this.repoDir,
        });
    }

    async assignmentOf(snapshotId: string, testCaseId: string) {
        return await this.db.testCaseAssignment.findUnique({
            where: { snapshotId_testCaseId: { snapshotId, testCaseId } },
            select: { planId: true, plan: { select: { prompt: true } } },
        });
    }

    async generationsOf(snapshotId: string) {
        return await this.db.testGeneration.findMany({
            where: { snapshotId },
            select: { id: true, status: true, testPlan: { select: { testCaseId: true, prompt: true } } },
        });
    }

    private async createSnapshot(
        branchId: string,
        options: { status: "processing" | "active" | "superseded"; headSha?: string },
    ): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "GITHUB_PUSH", status: options.status, headSha: options.headSha },
            select: { id: true },
        });
        return snapshot.id;
    }

    private async assign(snapshotId: string, testCaseId: string, planId: string): Promise<void> {
        await this.db.testCaseAssignment.create({ data: { snapshotId, testCaseId, planId } });
    }
}

integrationTestSuite({
    name: "runMergeFlow (absorbing a merged PR's plan work into main)",
    createHarness: () => MergeFlowHarness.create(),
    cases: (test) => {
        test("imports the branch's plan onto main's own plan record without starting a run", async ({ harness }) => {
            const scenario = await harness.seedMergeScenario();

            const result = await harness.runFlow(scenario);

            expect(result.merges.map((merge) => merge.prNumber)).toEqual([PR_NUMBER]);
            expect(result.imports.map((imported) => imported.slug).sort()).toEqual(
                [scenario.authored.slug, scenario.imported.slug].sort(),
            );

            // Main adopts the branch's prose, but on a plan record of its own: sharing the branch's row would let
            // main's run overwrite the steps the branch still points at.
            const assignment = await harness.assignmentOf(scenario.targetSnapshotId, scenario.imported.testCaseId);
            expect(assignment?.plan?.prompt).toBe(PLAN_ON_BRANCH);
            expect(assignment?.planId).not.toBe(scenario.imported.planIdOnBranch);
            expect(assignment?.planId).not.toBe(scenario.imported.planIdOnMain);

            // Each import carries the test its investigation target is keyed on; the Investigator starts the run.
            const imported = result.imports.find((entry) => entry.slug === scenario.imported.slug);
            expect(imported?.testCaseId).toBe(scenario.imported.testCaseId);
            expect(await harness.generationsOf(scenario.targetSnapshotId)).toEqual([]);
        });

        test("adopts a test authored on the branch without forking its identity", async ({ harness }) => {
            const scenario = await harness.seedMergeScenario();

            await harness.runFlow(scenario);

            // The same TestCase joins main's suite - a second one would carry a new slug and none of the history the
            // branch already recorded against this test.
            const assignment = await harness.assignmentOf(scenario.targetSnapshotId, scenario.authored.testCaseId);
            expect(assignment?.plan?.prompt).toBe(PLAN_ON_BRANCH);
            expect(
                await harness.db.testCase.count({
                    where: { applicationId: scenario.applicationId, slug: scenario.authored.slug },
                }),
            ).toBe(1);

            // The adoption is a suite edit only - no run is started for it here.
            expect(await harness.generationsOf(scenario.targetSnapshotId)).toEqual([]);
        });

        test("propagates a branch's deletion, and drops it when main modified the test since base", async ({
            harness,
        }) => {
            const scenario = await harness.seedMergeScenario();

            const result = await harness.runFlow(scenario);

            expect(result.removedSlugs).toEqual([scenario.deleted.slug]);
            expect(await harness.assignmentOf(scenario.targetSnapshotId, scenario.deleted.testCaseId)).toBeNull();
            // The TestCase itself survives the removal - only main's assignment goes.
            expect(await harness.db.testCase.count({ where: { id: scenario.deleted.testCaseId } })).toBe(1);

            // Modify wins: main edited this test after the branch forked, so the branch's removal is dropped and
            // main keeps its own plan untouched.
            const kept = await harness.assignmentOf(scenario.targetSnapshotId, scenario.keptOverDeletion.testCaseId);
            expect(kept?.planId).toBe(scenario.keptOverDeletion.planIdOnMain);
        });

        test("hands both-sides edits to the agent as conflicts and leaves untouched tests alone", async ({
            harness,
        }) => {
            const scenario = await harness.seedMergeScenario();

            const result = await harness.runFlow(scenario);

            // A deletion main overrode is a conflict too: the agent re-plans it with main's two versions in hand.
            expect(result.preClassifiedConflicts.map((conflict) => conflict.slug).sort()).toEqual(
                [scenario.conflicting.slug, scenario.keptOverDeletion.slug].sort(),
            );

            const untouched = await harness.assignmentOf(scenario.targetSnapshotId, scenario.untouched.testCaseId);
            expect(untouched?.planId).toBe(scenario.untouched.planIdOnMain);

            // The merge flow starts no runs at all: every import is targeted, and the Investigators start their own.
            expect(await harness.generationsOf(scenario.targetSnapshotId)).toEqual([]);
        });

        test("a commit range git cannot read leaves the suite untouched instead of failing the run", async ({
            harness,
        }) => {
            const scenario = await harness.seedMergeScenario();

            const result = await harness.runFlow(scenario, { baseSha: "0000000000000000000000000000000000000000" });

            expect(result).toEqual({ merges: [], preClassifiedConflicts: [], imports: [], removedSlugs: [] });
            expect(await harness.generationsOf(scenario.targetSnapshotId)).toEqual([]);
            expect(await harness.assignmentOf(scenario.targetSnapshotId, scenario.deleted.testCaseId)).not.toBeNull();
        });
    },
});
