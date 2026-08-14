import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { logger as rootLogger } from "@autonoma/logger";
import { expect } from "vitest";
import { loadBranchTests } from "../../src/activities/analysis/branch-tests";
import { seedAnalysisIssue, seedGenerationForSlug } from "./seed-generation";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const logger = rootLogger.child({ name: "branch-tests-test" });

let seq = 0;
const next = () => seq++;

interface SeededBranch {
    branchId: string;
    organizationId: string;
    applicationId: string;
}

/** One test's verdict at one snapshot, as the seeder writes it. */
interface SeededVerdict {
    slug: string;
    category: string;
    /** Whether the snapshot's suite still holds this test. A removed test keeps its findings but loses its assignment. */
    assigned?: boolean;
    /** An issue to attribute the finding to, which is how an environment gap's owner is recorded. */
    issueId?: string;
}

class BranchTestsHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<BranchTestsHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new BranchTestsHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    async seedBranch(): Promise<SeededBranch> {
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
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        return { branchId: branch.id, organizationId: org.id, applicationId: app.id };
    }

    /** One analyzed commit on the branch, with a verdict per test. Returns the snapshot id. */
    async seedSnapshot(branch: SeededBranch, headSha: string, verdicts: SeededVerdict[]): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId: branch.branchId, source: "GITHUB_PUSH", headSha },
        });
        await this.db.analysisJob.create({
            data: {
                snapshotId: snapshot.id,
                organizationId: branch.organizationId,
                status: "completed",
                startedAt: new Date(),
            },
        });

        for (const verdict of verdicts) {
            const { testCaseId, generationId } = await seedGenerationForSlug(this.db, {
                applicationId: branch.applicationId,
                organizationId: branch.organizationId,
                snapshotId: snapshot.id,
                slug: verdict.slug,
            });
            if (verdict.assigned !== false) {
                await this.db.testCaseAssignment.create({ data: { snapshotId: snapshot.id, testCaseId } });
            }
            const finding = await this.db.analysisFinding.create({
                data: {
                    reportSnapshotId: snapshot.id,
                    organizationId: branch.organizationId,
                    testCaseId,
                    issueId: verdict.issueId,
                },
            });
            const classification = await this.db.analysisClassification.create({
                data: {
                    findingId: finding.id,
                    number: 1,
                    organizationId: branch.organizationId,
                    generationId,
                    category: verdict.category,
                    headline: `${verdict.slug} headline`,
                },
            });
            await this.db.analysisFinding.update({
                where: { id: finding.id },
                data: { currentClassificationId: classification.id },
            });
        }
        return snapshot.id;
    }

    async seedOpenIssue(branch: SeededBranch, kind: string): Promise<string> {
        return await seedAnalysisIssue(this.db, {
            branchId: branch.branchId,
            organizationId: branch.organizationId,
            title: `${kind} gap`,
            kind,
            actualBehavior: "the preview lacked its configuration",
            narrativeMarkdown: "narrative",
        });
    }
}

/**
 * The cumulative reading of a pull request. This query is what makes the report describe the whole PR rather than its
 * newest commit, and both of its exclusions exist to stop the verified ratio from lying.
 */
integrationTestSuite({
    name: "loadBranchTests",
    createHarness: () => BranchTestsHarness.create(),
    cases: (test) => {
        test("carries a pass from an earlier commit that the latest one did not re-run", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.seedSnapshot(branch, "aaaaaaa1111", [{ slug: "checkout", category: "passed" }]);
            // The later commit only re-ran search: impact analysis judged checkout unaffected by this diff, which is
            // itself a decision, so checkout's earlier pass is still the best evidence we have.
            const latest = await harness.seedSnapshot(branch, "bbbbbbb2222", [{ slug: "search", category: "passed" }]);
            // The suite still holds both tests at the latest commit.
            await harness.db.testCaseAssignment.create({
                data: {
                    snapshotId: latest,
                    testCaseId: (await harness.db.testCase.findFirstOrThrow({ where: { slug: "checkout" } })).id,
                },
            });

            const tests = await loadBranchTests(branch.branchId, latest, logger);

            expect(tests.map((t) => t.slug)).toEqual(["checkout", "search"]);
            const checkout = tests.find((t) => t.slug === "checkout");
            expect(checkout?.category).toBe("passed");
            expect(checkout?.checkedThisRun).toBe(false);
            expect(checkout?.fromSha).toBe("aaaaaaa");
            expect(tests.find((t) => t.slug === "search")?.checkedThisRun).toBe(true);
        });

        test("lets a later failure supersede the same test's earlier pass", async ({ harness }) => {
            const branch = await harness.seedBranch();
            await harness.seedSnapshot(branch, "aaaaaaa1111", [{ slug: "checkout", category: "passed" }]);
            const latest = await harness.seedSnapshot(branch, "bbbbbbb2222", [
                { slug: "checkout", category: "client_bug" },
            ]);

            const tests = await loadBranchTests(branch.branchId, latest, logger);

            expect(tests).toHaveLength(1);
            expect(tests[0]?.category).toBe("client_bug");
            expect(tests[0]?.checkedThisRun).toBe(true);
        });

        test("excludes a removed test, which is a conclusion rather than a gap", async ({ harness }) => {
            const branch = await harness.seedBranch();
            const latest = await harness.seedSnapshot(branch, "aaaaaaa1111", [
                { slug: "checkout", category: "passed" },
                { slug: "legacy-flow", category: "invalid_test" },
            ]);

            const tests = await loadBranchTests(branch.branchId, latest, logger);

            expect(tests.map((t) => t.slug)).toEqual(["checkout"]);
        });

        test("excludes a test the suite no longer holds, so its stale gap stops counting", async ({ harness }) => {
            const branch = await harness.seedBranch();
            // Deleting a test unassigns it rather than destroying it, so its findings outlive the suite membership.
            // Without this exclusion the gap would drag the ratio down for the rest of the branch's life.
            await harness.seedSnapshot(branch, "aaaaaaa1111", [{ slug: "dropped", category: "engine_artifact" }]);
            const latest = await harness.seedSnapshot(branch, "bbbbbbb2222", [
                { slug: "checkout", category: "passed" },
            ]);

            const tests = await loadBranchTests(branch.branchId, latest, logger);

            expect(tests.map((t) => t.slug)).toEqual(["checkout"]);
        });

        test("records an environment gap as the reader's only when an open non-bug issue claims it", async ({
            harness,
        }) => {
            const branch = await harness.seedBranch();
            const envIssue = await harness.seedOpenIssue(branch, "environment");
            const latest = await harness.seedSnapshot(branch, "aaaaaaa1111", [
                { slug: "configured", category: "environment_failure", issueId: envIssue },
                { slug: "unplaced", category: "environment_failure" },
            ]);

            const tests = await loadBranchTests(branch.branchId, latest, logger);

            // An attributed env gap is fixable configuration; an unattributed one stays ours rather than nagging.
            expect(tests.find((t) => t.slug === "configured")?.attributedToClientIssue).toBe(true);
            expect(tests.find((t) => t.slug === "unplaced")?.attributedToClientIssue).toBe(false);
        });

        test("does not read a bug issue's attribution as a coverage placement", async ({ harness }) => {
            const branch = await harness.seedBranch();
            const bugIssue = await harness.seedOpenIssue(branch, "bug");
            const latest = await harness.seedSnapshot(branch, "aaaaaaa1111", [
                { slug: "checkout", category: "client_bug", issueId: bugIssue },
            ]);

            const tests = await loadBranchTests(branch.branchId, latest, logger);

            expect(tests[0]?.attributedToClientIssue).toBe(false);
        });
    },
});
