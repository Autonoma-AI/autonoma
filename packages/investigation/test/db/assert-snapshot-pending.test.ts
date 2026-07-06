import { expect } from "vitest";
import { assertSnapshotPending } from "../../src";
import { investigationDbSuite } from "../harness";

investigationDbSuite({
    name: "assertSnapshotPending",
    cases: (test) => {
        test("resolves for a processing twin (the snapshot the agent is meant to run against)", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const twin = await harness.createTwinSnapshot(branchId, { status: "processing" });

            await expect(assertSnapshotPending(harness.db, twin)).resolves.toBeUndefined();
        });

        test("throws for an active snapshot (e.g. a diffs snapshot the workflow was mis-pointed at)", async ({
            harness,
            seedResult: { organizationId, application },
        }) => {
            const branchId = await harness.createBranch(organizationId, application.id);
            const active = await harness.createTwinSnapshot(branchId, { status: "active" });

            await expect(assertSnapshotPending(harness.db, active)).rejects.toThrow(/is "active"/);
        });

        test("throws for a snapshot id that does not exist", async ({ harness }) => {
            await expect(assertSnapshotPending(harness.db, "does-not-exist")).rejects.toThrow(/not found/);
        });
    },
});
