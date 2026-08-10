import { expect } from "vitest";
import { AddTest } from "../src/changes/add-test";
import { testUpdateSuite } from "./harness";

testUpdateSuite({
    name: "TestSuiteUpdater",
    cases: (test) => {
        test("apply: adds a test case without starting a run", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const updater = await harness.startUpdater(organizationId, applicationId);

            await updater.apply(
                new AddTest({
                    folderId,
                    name: "Apply test",
                    description: "Tests apply",
                    plan: "Some plan",
                }),
            );

            const suite = await updater.currentTestSuiteInfo();
            expect(suite.testCases).toHaveLength(1);
            expect(await harness.db.testGeneration.count({ where: { snapshotId: updater.snapshotId } })).toBe(0);
        });

        // -- finalize() --

        test("finalize: activates the snapshot", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const updater = await harness.startUpdater(organizationId, applicationId);

            await updater.apply(
                new AddTest({
                    folderId,
                    name: "Finalize test",
                    description: "Tests finalize",
                    plan: "Some plan",
                }),
            );

            await updater.finalize();

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: updater.snapshotId },
                select: { status: true },
            });
            expect(snapshot.status).toBe("active");
        });

        // -- getChanges() --

        test("getChanges: reflects applied AddTest changes", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const updater = await harness.startUpdater(organizationId, applicationId);

            await updater.apply(
                new AddTest({
                    folderId,
                    name: "New test",
                    description: "Tests getChanges",
                    plan: "New plan",
                }),
            );

            const changes = await updater.getChanges();
            expect(changes).toHaveLength(1);

            const added = changes.find((c) => c.type === "added");
            expect(added?.testCaseName).toBe("New test");
        });

        // -- cancel() --

        test("cancel: marks snapshot cancelled and clears the branch's pending pointer", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const updater = await harness.startUpdater(organizationId, applicationId);
            const snapshotId = updater.snapshotId;

            await updater.cancel();

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: updater.branchId },
                select: { pendingSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBeNull();

            // The snapshot is preserved for observability, marked cancelled.
            const snapshot = await harness.db.branchSnapshot.findUnique({
                where: { id: snapshotId },
                select: { status: true },
            });
            expect(snapshot?.status).toBe("cancelled");
        });
    },
});
