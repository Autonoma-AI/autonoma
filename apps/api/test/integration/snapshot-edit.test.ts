import { ApplicationArchitecture } from "@autonoma/db";
import { BranchAlreadyHasPendingSnapshotError, SnapshotNotPendingError } from "@autonoma/test-updates";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

async function createBranch(harness: APITestHarness): Promise<string> {
    const application = await harness.services.applications.createApplication({
        name: `App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by createApplication
    return application.mainBranchId!;
}

apiTestSuite({
    name: "snapshotEdit",
    seed: async ({ harness }) => {
        const branchId = await createBranch(harness);
        return { branchId };
    },
    cases: (test) => {
        test("start creates a pending snapshot and returns test suite", async ({
            harness,
            seedResult: { branchId },
        }) => {
            const result = await harness.request().snapshotEdit.start({ branchId });

            expect(result.snapshotId).toBeDefined();
            expect(result.testSuite).toBeDefined();
            expect(result.testSuite.testCases).toEqual([]);

            await harness.request().snapshotEdit.discard({ branchId });
        });

        test("get returns the edit session state", async ({ harness, seedResult: { branchId } }) => {
            await harness.request().snapshotEdit.start({ branchId });

            const session = await harness.request().snapshotEdit.get({ branchId });

            expect(session.snapshotId).toBeDefined();
            expect(session.testSuite).toBeDefined();
            expect(session.generationSummary).toBeDefined();
            expect(session.changes).toBeDefined();
            expect(session.changes).toHaveLength(0);
            expect(session.generationSummary).toHaveLength(0);

            await harness.request().snapshotEdit.discard({ branchId });
        });

        test("addTest adds a test case to the snapshot", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.addTest({
                branchId,
                name: "Login test",
                plan: "Navigate to login and verify form",
            });

            const session = await harness.request().snapshotEdit.get({ branchId });
            expect(session.testSuite.testCases).toHaveLength(1);
            expect(session.testSuite.testCases[0]?.name).toBe("Login test");

            const addedChanges = session.changes.filter((c) => c.type === "added");
            expect(addedChanges).toHaveLength(1);
        });

        test("addTests adds multiple tests in bulk", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.addTests({
                branchId,
                tests: [
                    { name: "Test A", plan: "Plan A" },
                    { name: "Test B", plan: "Plan B" },
                    { name: "Test C", plan: "Plan C" },
                ],
            });

            const session = await harness.request().snapshotEdit.get({ branchId });
            expect(session.testSuite.testCases).toHaveLength(3);

            const names = session.testSuite.testCases.map((tc) => tc.name);
            expect(names).toContain("Test A");
            expect(names).toContain("Test B");
            expect(names).toContain("Test C");
        });

        test("updateTest updates a test plan", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                branchId,
                name: "Updatable test",
                plan: "Original plan",
            });

            const beforeUpdate = await harness.request().snapshotEdit.get({ branchId });
            // biome-ignore lint/style/noNonNullAssertion: just created
            const testCaseId = beforeUpdate.testSuite.testCases[0]!.id;

            await harness.request().snapshotEdit.updateTest({
                branchId,
                testCaseId,
                plan: "Updated plan",
            });

            const afterUpdate = await harness.request().snapshotEdit.get({ branchId });
            const updatedTest = afterUpdate.testSuite.testCases.find((tc) => tc.id === testCaseId);
            expect(updatedTest?.plan?.prompt).toBe("Updated plan");
        });

        test("removeTest removes a test from the snapshot", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                branchId,
                name: "Test to remove",
                plan: "Will be removed",
            });

            const before = await harness.request().snapshotEdit.get({ branchId });
            expect(before.testSuite.testCases).toHaveLength(1);
            // biome-ignore lint/style/noNonNullAssertion: just created
            const testCaseId = before.testSuite.testCases[0]!.id;

            await harness.request().snapshotEdit.removeTest({ branchId, testCaseId });

            const after = await harness.request().snapshotEdit.get({ branchId });
            expect(after.testSuite.testCases).toHaveLength(0);
        });

        test("queueGenerations fires generation jobs via the provider", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                branchId,
                name: "Generate me",
                plan: "Run generation",
            });

            const batchesBefore = harness.generationProvider.firedBatches.length;

            await harness.request().snapshotEdit.queueGenerations({ branchId });

            expect(harness.generationProvider.firedBatches.length).toBe(batchesBefore + 1);
            const lastBatch = harness.generationProvider.firedBatches.at(-1);
            expect(lastBatch).toHaveLength(1);
            expect(lastBatch?.[0]?.testGenerationId).toBeDefined();
        });

        test("finalize activates the snapshot", async ({ harness }) => {
            const branchId = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.finalize({ branchId });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { activeSnapshotId: true, pendingSnapshotId: true },
            });
            expect(branch.activeSnapshotId).toBe(snapshotId);
            expect(branch.pendingSnapshotId).toBeNull();
        });

        test("discard removes the pending snapshot", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.discard({ branchId });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { pendingSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBeNull();
        });

        test("start throws NOT_FOUND for a non-existent branch", async ({ harness }) => {
            await expect(
                harness.request().snapshotEdit.start({ branchId: "non-existent-branch" }),
            ).rejects.toBeInstanceOf(TRPCError);
        });

        test("start throws NOT_FOUND when branch belongs to a different organization", async ({
            harness,
            seedResult: { branchId },
        }) => {
            const otherOrg = await harness.db.organization.create({
                data: { name: "Other Org", slug: `other-org-${crypto.randomUUID()}` },
            });
            const otherSession = await harness.db.session.create({
                data: {
                    token: `other-session-${crypto.randomUUID()}`,
                    expiresAt: new Date(Date.now() + 86400000),
                    userId: harness.userId,
                    activeOrganizationId: otherOrg.id,
                },
            });

            await expect(harness.request(otherSession).snapshotEdit.start({ branchId })).rejects.toBeInstanceOf(
                TRPCError,
            );
        });

        test("start throws when branch already has a pending snapshot", async ({ harness }) => {
            const branchId = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });

            const error = await harness
                .request()
                .snapshotEdit.start({ branchId })
                .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(TRPCError);
            expect((error as TRPCError).cause).toBeInstanceOf(BranchAlreadyHasPendingSnapshotError);
        });

        test("get throws when no pending snapshot exists", async ({ harness }) => {
            const branchId = await createBranch(harness);

            const error = await harness
                .request()
                .snapshotEdit.get({ branchId })
                .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(TRPCError);
            expect((error as TRPCError).cause).toBeInstanceOf(SnapshotNotPendingError);
        });
    },
});
