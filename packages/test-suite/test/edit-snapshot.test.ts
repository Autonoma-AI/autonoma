import { expect } from "vitest";
import { BranchAlreadyOpenError } from "../src/errors";
import { EDIT_SNAPSHOT_TRIGGER } from "../src/test-suite-store";
import { testSuiteSuite } from "./harness";

testSuiteSuite({
    name: "TestSuiteStore.openEditSnapshot",
    cases: (test) => {
        test("forks the branch's active snapshot and inherits its head as both head and base", async ({ harness }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const existing = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const activeSnapshotId = await harness.createActiveSnapshot(branchId, {
                headSha: "live-head",
                assignments: [existing],
            });

            const open = await harness.store.openEditSnapshot({ branchId, organizationId });

            expect(open.headSha).toBe("live-head");
            expect(open.baseSha).toBe("live-head");
            expect(open.trigger).toBe(EDIT_SNAPSHOT_TRIGGER);

            const suite = await open.read();
            expect(suite.testCases.map((testCase) => testCase.id)).toEqual([existing.testCaseId]);

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: open.snapshotId },
                select: { prevSnapshotId: true, branch: { select: { pendingSnapshotId: true } } },
            });
            expect(snapshot.prevSnapshotId).toBe(activeSnapshotId);
            expect(snapshot.branch.pendingSnapshotId).toBe(open.snapshotId);
        });

        test("opens on a branch with no active snapshot, carrying no git coordinates", async ({ harness }) => {
            const { organizationId, branchId } = await harness.seedContext();

            const open = await harness.store.openEditSnapshot({ branchId, organizationId });

            expect(open.headSha).toBeUndefined();
            expect(open.baseSha).toBeUndefined();
            expect((await open.read()).testCases).toEqual([]);
        });

        test("refuses to open while the branch's pending slot is taken", async ({ harness }) => {
            const { organizationId, branchId } = await harness.seedContext();
            const first = await harness.store.openEditSnapshot({ branchId, organizationId });

            const second = harness.store.openEditSnapshot({ branchId, organizationId });

            await expect(second).rejects.toThrow(BranchAlreadyOpenError);
            await expect(second).rejects.toMatchObject({ pendingSnapshotId: first.snapshotId });
        });

        test("editing the suite starts no run", async ({ harness }) => {
            const { organizationId, branchId, folderId } = await harness.seedContext();
            const open = await harness.store.openEditSnapshot({ branchId, organizationId });

            const { testCaseId } = await open.addTest({
                name: "Edited only",
                description: "an authored claim",
                plan: "1. Do the thing.",
                folderId,
            });
            await open.revisePlan({ testCaseId, plan: "2. Do it differently." });

            expect(await harness.store.latestRunPerTest(open.snapshotId)).toEqual([]);
        });

        test("latestRunPerTest reports each test's most recent run", async ({ harness }) => {
            const { organizationId, branchId, folderId } = await harness.seedContext();
            const open = await harness.store.openEditSnapshot({ branchId, organizationId });
            const { testCaseId } = await open.addTest({
                name: "Run twice",
                description: "a claim run more than once",
                plan: "1. Do the thing.",
                folderId,
            });

            const first = await open.startRun(testCaseId);
            await harness.db.testGeneration.update({ where: { id: first.runId }, data: { status: "failed" } });
            const second = await open.startRun(testCaseId);

            const runs = await harness.store.latestRunPerTest(open.snapshotId);
            expect(runs).toEqual([expect.objectContaining({ testCaseId, runId: second.runId, status: "pending" })]);
        });
    },
});
