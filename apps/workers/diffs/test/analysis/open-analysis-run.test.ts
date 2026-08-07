import { ApplicationArchitecture, type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { openAnalysisRun } from "../../src/activities/analysis/open-analysis-run";

declare global {
    // eslint-disable-next-line no-var
    var prisma: PrismaClient | undefined;
}

const HEAD_SHA = "head1111111111111111111111111111111111111";
const BASE_SHA = "base2222222222222222222222222222222222222";

let seq = 0;
const next = () => seq++;

interface SeedOptions {
    architecture?: ApplicationArchitecture;
    folders?: number;
}

class OpenRunHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<OpenRunHarness> {
        const connectionUri = await createTestDatabase();
        const db = createClient(connectionUri);
        globalThis.prisma = db;
        return new OpenRunHarness(db);
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** A branch on an application with the given architecture and folder count, and no snapshots yet. */
    async seedBranch(options: SeedOptions = {}): Promise<string> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: {
                name: `App ${n}`,
                slug: `app-${n}`,
                organizationId: org.id,
                architecture: options.architecture ?? ApplicationArchitecture.WEB,
            },
        });
        for (let i = 0; i < (options.folders ?? 1); i++) {
            await this.db.folder.create({
                data: { name: `Flow ${i}`, applicationId: app.id, organizationId: org.id },
            });
        }
        const branch = await this.db.branch.create({
            data: { name: `feature/${n}`, applicationId: app.id, organizationId: org.id },
        });
        return branch.id;
    }

    async jobCount(branchId: string): Promise<number> {
        return await this.db.analysisJob.count({ where: { snapshot: { branchId } } });
    }

    /** Make `branchId` the application's main branch, with an active snapshot at the given head carrying one test. */
    async seedMainSuite(branchId: string, headSha: string): Promise<{ mainSnapshotId: string }> {
        const branch = await this.db.branch.findUniqueOrThrow({
            where: { id: branchId },
            select: { applicationId: true, organizationId: true },
        });
        await this.db.application.update({
            where: { id: branch.applicationId },
            data: { mainBranchId: branchId },
        });
        const folder = await this.db.folder.findFirstOrThrow({
            where: { applicationId: branch.applicationId },
            select: { id: true },
        });
        const testCase = await this.db.testCase.create({
            data: {
                name: "Main test",
                slug: `main-test-${next()}`,
                applicationId: branch.applicationId,
                folderId: folder.id,
                organizationId: branch.organizationId,
            },
        });
        const plan = await this.db.testPlan.create({
            data: { testCaseId: testCase.id, prompt: "main plan", organizationId: branch.organizationId },
        });
        const snapshot = await this.db.branchSnapshot.create({
            data: { branchId, source: "GITHUB_PUSH", status: "active", headSha },
        });
        await this.db.testCaseAssignment.create({
            data: { snapshotId: snapshot.id, testCaseId: testCase.id, planId: plan.id },
        });
        await this.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: snapshot.id } });
        return { mainSnapshotId: snapshot.id };
    }

    /** A feature branch on the same application as `mainBranchId`. */
    async seedSiblingBranch(mainBranchId: string): Promise<string> {
        const main = await this.db.branch.findUniqueOrThrow({
            where: { id: mainBranchId },
            select: { applicationId: true, organizationId: true },
        });
        const branch = await this.db.branch.create({
            data: {
                name: `feature/sibling-${next()}`,
                applicationId: main.applicationId,
                organizationId: main.organizationId,
            },
        });
        return branch.id;
    }
}

integrationTestSuite({
    name: "openAnalysisRun (application preconditions)",
    createHarness: () => OpenRunHarness.create(),
    cases: (test) => {
        test("opens the run for a web application that has folders", async ({ harness }) => {
            const branchId = await harness.seedBranch();

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result.skipped).toBe(false);
            expect(await harness.jobCount(branchId)).toBe(1);
        });

        test("refuses a non-web application without opening a run", async ({ harness }) => {
            const branchId = await harness.seedBranch({ architecture: ApplicationArchitecture.IOS });

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result).toEqual({ skipped: true, reason: "unsupported_architecture" });
            expect(await harness.jobCount(branchId)).toBe(0);
        });

        test("refuses an application with no folders without opening a run", async ({ harness }) => {
            const branchId = await harness.seedBranch({ folders: 0 });

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result).toEqual({ skipped: true, reason: "no_test_folders" });
            expect(await harness.jobCount(branchId)).toBe(0);
        });

        // A branch holds at most one pending snapshot, so a second push has to take the branch over rather than be
        // refused. Cancelling the displaced run's workflow is Temporal's job (runs are keyed on the branch with a
        // terminate-existing policy); settling its database state is this activity's, and termination runs no
        // workflow code, so without it the old run would dangle in `running` forever.
        test("supersedes the run already in flight on the branch", async ({ harness }) => {
            const branchId = await harness.seedBranch();
            const open = (headSha: string, baseSha: string) => openAnalysisRun({ branchId, headSha, baseSha });

            const stale = await open("head-old", "base-old");
            const fresh = await open("head-new", "base-new");
            if (stale.skipped || fresh.skipped) throw new Error("expected both runs to open");
            expect(fresh.snapshotId).not.toBe(stale.snapshotId);

            const staleSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: stale.snapshotId },
            });
            // A superseded run settles its snapshot `cancelled`: it never reached a verdict, so it is closed out
            // rather than recorded as one.
            expect(staleSnapshot.status).toBe("cancelled");
            const staleJob = await harness.db.analysisJob.findUniqueOrThrow({
                where: { snapshotId: stale.snapshotId },
            });
            expect(staleJob.status).toBe("failed");
            expect(staleJob.failureReason).toContain("Superseded");
            expect(staleJob.completedAt).not.toBeNull();

            const freshSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: fresh.snapshotId },
            });
            expect(freshSnapshot.status).toBe("processing");
        });

        test("skips a head that is already analyzed", async ({ harness }) => {
            const branchId = await harness.seedBranch();
            await harness.seedMainSuite(branchId, HEAD_SHA);

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            expect(result).toEqual({ skipped: true, reason: "already_analyzed" });
            expect(await harness.jobCount(branchId)).toBe(0);
        });

        // A new PR branch inherits main's live suite, but the diff base stays its own PR base: main's snapshot
        // head can lag the real fork point when merges to main are not analyzed.
        test("a new PR branch forks from main's active snapshot and diffs against its own PR base", async ({
            harness,
        }) => {
            const mainBranchId = await harness.seedBranch();
            const { mainSnapshotId } = await harness.seedMainSuite(mainBranchId, "main-head-sha");
            const branchId = await harness.seedSiblingBranch(mainBranchId);

            const result = await openAnalysisRun({ branchId, headSha: HEAD_SHA, baseSha: BASE_SHA });

            if (result.skipped) throw new Error("expected the run to open");
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: result.snapshotId },
                include: { testCaseAssignments: true },
            });
            expect(snapshot.prevSnapshotId).toBe(mainSnapshotId);
            expect(snapshot.baseSha).toBe(BASE_SHA);
            expect(snapshot.headSha).toBe(HEAD_SHA);
            // The inherited suite is copied forward, and the fork point is pinned for the PR diff view.
            expect(snapshot.testCaseAssignments).toHaveLength(1);
            const branch = await harness.db.branch.findUniqueOrThrow({ where: { id: branchId } });
            expect(branch.baseSnapshotId).toBe(mainSnapshotId);
            expect(branch.pendingSnapshotId).toBe(result.snapshotId);
        });
    },
});
