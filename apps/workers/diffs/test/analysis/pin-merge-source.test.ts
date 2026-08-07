import { type PrismaClient, createClient } from "@autonoma/db";
import { createTestDatabase, type IntegrationHarness, integrationTestSuite } from "@autonoma/integration-test";
import { expect } from "vitest";
import { pinMergeSource } from "../../src/analysis/pin-merge-source";

let seq = 0;
const next = () => seq++;

interface SnapshotOptions {
    status?: "processing" | "active";
    headSha?: string;
    prevSnapshotId?: string;
}

class PinMergeSourceHarness implements IntegrationHarness {
    constructor(public readonly db: PrismaClient) {}

    static async create(): Promise<PinMergeSourceHarness> {
        const connectionUri = await createTestDatabase();
        return new PinMergeSourceHarness(createClient(connectionUri));
    }

    async beforeAll() {}
    async afterAll() {
        await this.db.$disconnect();
    }
    async beforeEach() {}
    async afterEach() {}

    /** One application to hang a merge's branches off. */
    async seedApplication(): Promise<{ organizationId: string; applicationId: string }> {
        const n = next();
        const org = await this.db.organization.create({ data: { name: `Org ${n}`, slug: `org-${n}` } });
        const app = await this.db.application.create({
            data: { name: `App ${n}`, slug: `app-${n}`, organizationId: org.id, architecture: "WEB" },
        });
        return { organizationId: org.id, applicationId: app.id };
    }

    /** A branch, registered against a PR number when one is given (which is how a merge finds it). */
    async seedBranch(organizationId: string, applicationId: string, options?: { prNumber?: number }): Promise<string> {
        const n = next();
        const branch = await this.db.branch.create({
            data: {
                name: `feat/branch-${n}`,
                organizationId,
                applicationId,
                prInfo:
                    options?.prNumber != null ? { create: { applicationId, prNumber: options.prNumber } } : undefined,
            },
        });
        return branch.id;
    }

    /** A snapshot on the branch, wired as its active pointer when created `active`. */
    async seedSnapshot(branchId: string, options: SnapshotOptions = {}): Promise<string> {
        const snapshot = await this.db.branchSnapshot.create({
            data: {
                branchId,
                source: "MANUAL",
                status: options.status ?? "processing",
                headSha: options.headSha,
                prevSnapshotId: options.prevSnapshotId,
            },
            select: { id: true },
        });
        if (options.status === "active") {
            await this.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: snapshot.id } });
        }
        return snapshot.id;
    }
}

integrationTestSuite({
    name: "pinMergeSource",
    createHarness: () => PinMergeSourceHarness.create(),
    cases: (test) => {
        test("pins the branch's active snapshot when it sits at the PR's exact head sha", async ({ harness }) => {
            const { organizationId, applicationId } = await harness.seedApplication();
            const mainBranchId = await harness.seedBranch(organizationId, applicationId);
            const baseSnapshotId = await harness.seedSnapshot(mainBranchId, {
                status: "active",
                headSha: "main-base",
            });

            const branchId = await harness.seedBranch(organizationId, applicationId, { prNumber: 42 });
            await harness.db.branch.update({ where: { id: branchId }, data: { baseSnapshotId } });
            const snapshotId = await harness.seedSnapshot(branchId, { status: "active", headSha: "feat-sha" });

            const pinned = await pinMergeSource(harness.db, { applicationId, prNumber: 42, sourceHeadSha: "feat-sha" });

            expect(pinned).toMatchObject({ snapshotId, branchId, prNumber: 42, headSha: "feat-sha", baseSnapshotId });
        });

        test("falls back to what the active snapshot was opened from when no fork point was pinned", async ({
            harness,
        }) => {
            const { organizationId, applicationId } = await harness.seedApplication();
            const branchId = await harness.seedBranch(organizationId, applicationId, { prNumber: 43 });
            const prevSnapshotId = await harness.seedSnapshot(branchId, { status: "active", headSha: "prev-sha" });
            await harness.seedSnapshot(branchId, { status: "active", headSha: "feat-sha", prevSnapshotId });

            const pinned = await pinMergeSource(harness.db, { applicationId, prNumber: 43, sourceHeadSha: "feat-sha" });

            expect(pinned?.baseSnapshotId).toBe(prevSnapshotId);
        });

        test("still pins, with no merge base, when the branch has neither a fork point nor a predecessor", async ({
            harness,
        }) => {
            const { organizationId, applicationId } = await harness.seedApplication();
            const branchId = await harness.seedBranch(organizationId, applicationId, { prNumber: 44 });
            await harness.seedSnapshot(branchId, { status: "active", headSha: "feat-sha" });

            const pinned = await pinMergeSource(harness.db, { applicationId, prNumber: 44, sourceHeadSha: "feat-sha" });

            expect(pinned).toBeDefined();
            expect(pinned?.baseSnapshotId).toBeNull();
        });

        // Each of these leaves the merge to the agent's normal code_change path rather than risk importing a plan
        // from the wrong commit.
        test("declines a PR with no branch registered for it", async ({ harness }) => {
            const { applicationId } = await harness.seedApplication();

            const pinned = await pinMergeSource(harness.db, {
                applicationId,
                prNumber: 9999,
                sourceHeadSha: "deadbeef",
            });

            expect(pinned).toBeUndefined();
        });

        test("declines a branch whose snapshot never settled, so nothing is pinned at the sha", async ({ harness }) => {
            const { organizationId, applicationId } = await harness.seedApplication();
            const branchId = await harness.seedBranch(organizationId, applicationId, { prNumber: 123 });
            await harness.seedSnapshot(branchId, { status: "processing", headSha: "abc123" });

            const pinned = await pinMergeSource(harness.db, { applicationId, prNumber: 123, sourceHeadSha: "abc123" });

            expect(pinned).toBeUndefined();
        });

        test("declines when the active snapshot sits at a different sha than the PR merged", async ({ harness }) => {
            const { organizationId, applicationId } = await harness.seedApplication();
            const branchId = await harness.seedBranch(organizationId, applicationId, { prNumber: 7 });
            await harness.seedSnapshot(branchId, { status: "active", headSha: "real-sha" });

            const pinned = await pinMergeSource(harness.db, {
                applicationId,
                prNumber: 7,
                sourceHeadSha: "different-sha",
            });

            expect(pinned).toBeUndefined();
        });
    },
});
