import { ApplicationArchitecture, TriggerSource } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { startAnalysisRun } from "@autonoma/test-updates";
import { TRPCError } from "@trpc/server";
import { expect } from "vitest";
import {
    AnalysisInFlightError,
    EditSessionAlreadyOpenError,
    EditSessionSupersededError,
} from "../../src/routes/snapshot-edit/edit-session-errors";
import { apiTestSuite } from "../api-test";
import type { APITestHarness } from "../harness";

async function createBranch(harness: APITestHarness): Promise<{ branchId: string; folderId: string }> {
    const application = await harness.services.applications.createApplication({
        name: `App ${crypto.randomUUID()}`,
        organizationId: harness.organizationId,
        architecture: ApplicationArchitecture.WEB,
        url: "https://example.com",
        file: "s3://bucket/file.png",
    });
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by createApplication
    const branchId = application.mainBranchId!;
    const folder = await harness.db.folder.create({
        data: { name: "default", applicationId: application.id, organizationId: harness.organizationId },
        select: { id: true },
    });
    return { branchId, folderId: folder.id };
}

/** Opens an analysis run the way a push does: it supersedes whatever snapshot was pending on the branch. */
async function pushCommit(harness: APITestHarness, branchId: string): Promise<string> {
    return await startAnalysisRun({
        db: harness.db,
        logger,
        branchId,
        headSha: `head-${crypto.randomUUID()}`,
        baseSha: `base-${crypto.randomUUID()}`,
    });
}

/** Asserts the call was refused with a 409 and hands back the typed error the router mapped. */
function conflictCause(error: unknown) {
    expect(error).toBeInstanceOf(TRPCError);
    if (!(error instanceof TRPCError)) return undefined;
    expect(error.code).toBe("CONFLICT");
    return error.cause;
}

apiTestSuite({
    name: "snapshotEdit",
    seed: async ({ harness }) => {
        const { branchId, folderId } = await createBranch(harness);
        return { branchId, folderId };
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

            await harness.request().snapshotEdit.discard({ snapshotId: result.snapshotId });
        });

        test("get returns the edit session state", async ({ harness, seedResult: { branchId } }) => {
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            const session = await harness.request().snapshotEdit.get({ snapshotId });

            expect(session.snapshotId).toBe(snapshotId);
            expect(session.testSuite).toBeDefined();
            expect(session.generationSummary).toBeDefined();
            expect(session.changes).toBeDefined();
            expect(session.changes).toHaveLength(0);
            expect(session.generationSummary).toHaveLength(0);

            await harness.request().snapshotEdit.discard({ snapshotId });
        });

        test("addTest adds a test case to the snapshot", async ({ harness }) => {
            const { branchId, folderId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.addTest({
                snapshotId,
                name: "Login test",
                description: "Verifies that a user can log in with valid credentials.",
                plan: "Navigate to login and verify form",
                folderId,
            });

            const session = await harness.request().snapshotEdit.get({ snapshotId });
            expect(session.testSuite.testCases).toHaveLength(1);
            expect(session.testSuite.testCases[0]?.name).toBe("Login test");

            const addedChanges = session.changes.filter((c) => c.type === "added");
            expect(addedChanges).toHaveLength(1);
        });

        test("addTests adds multiple tests in bulk", async ({ harness }) => {
            const { branchId, folderId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.addTests({
                snapshotId,
                tests: [
                    { name: "Test A", plan: "Plan A", folderId, description: "Exercises behavior A end to end." },
                    { name: "Test B", plan: "Plan B", folderId, description: "Exercises behavior B end to end." },
                    { name: "Test C", plan: "Plan C", folderId, description: "Exercises behavior C end to end." },
                ],
            });

            const session = await harness.request().snapshotEdit.get({ snapshotId });
            expect(session.testSuite.testCases).toHaveLength(3);

            const names = session.testSuite.testCases.map((tc) => tc.name);
            expect(names).toContain("Test A");
            expect(names).toContain("Test B");
            expect(names).toContain("Test C");
        });

        test("updateTest updates a test plan", async ({ harness }) => {
            const { branchId, folderId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                snapshotId,
                name: "Updatable test",
                description: "Confirms the test plan can be updated after creation.",
                plan: "Original plan",
                folderId,
            });

            const beforeUpdate = await harness.request().snapshotEdit.get({ snapshotId });
            // biome-ignore lint/style/noNonNullAssertion: just created
            const testCaseId = beforeUpdate.testSuite.testCases[0]!.id;

            await harness.request().snapshotEdit.updateTest({
                snapshotId,
                testCaseId,
                plan: "Updated plan",
            });

            const afterUpdate = await harness.request().snapshotEdit.get({ snapshotId });
            const updatedTest = afterUpdate.testSuite.testCases.find((tc) => tc.id === testCaseId);
            expect(updatedTest?.plan?.prompt).toBe("Updated plan");
        });

        test("removeTest removes a test from the snapshot", async ({ harness }) => {
            const { branchId, folderId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                snapshotId,
                name: "Test to remove",
                description: "A throwaway test that exists only to be removed.",
                plan: "Will be removed",
                folderId,
            });

            const before = await harness.request().snapshotEdit.get({ snapshotId });
            expect(before.testSuite.testCases).toHaveLength(1);
            // biome-ignore lint/style/noNonNullAssertion: just created
            const testCaseId = before.testSuite.testCases[0]!.id;

            await harness.request().snapshotEdit.removeTest({ snapshotId, testCaseId });

            const after = await harness.request().snapshotEdit.get({ snapshotId });
            expect(after.testSuite.testCases).toHaveLength(0);
        });

        test("queueGenerations fires generation jobs via the provider", async ({ harness }) => {
            const { branchId, folderId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                snapshotId,
                name: "Generate me",
                description: "Ensures generation jobs fire when the test is queued.",
                plan: "Run generation",
                folderId,
            });

            const batchesBefore = harness.generationProvider.firedBatches.length;

            await harness.request().snapshotEdit.queueGenerations({ snapshotId });

            expect(harness.generationProvider.firedBatches.length).toBe(batchesBefore + 1);
            const lastBatch = harness.generationProvider.firedBatches.at(-1);
            expect(lastBatch?.generations).toHaveLength(1);
            expect(lastBatch?.generations[0]?.testGenerationId).toBeDefined();
        });

        test("finalize activates the snapshot", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.finalize({ snapshotId });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { activeSnapshotId: true, pendingSnapshotId: true },
            });
            expect(branch.activeSnapshotId).toBe(snapshotId);
            expect(branch.pendingSnapshotId).toBeNull();
        });

        test("start carries the active snapshot's headSha into the edit snapshot", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const activeSnapshot = await harness.db.branchSnapshot.create({
                data: {
                    branchId,
                    status: "active",
                    source: TriggerSource.WEBHOOK,
                    headSha: "handled-sha-123",
                    baseSha: "handled-sha-123",
                },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branchId },
                data: { activeSnapshotId: activeSnapshot.id },
            });

            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            // A manual edit does not advance the commit, so the edit snapshot must keep
            // the active snapshot's headSha (as both head and base) rather than null.
            const editSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: snapshotId },
                select: { headSha: true, baseSha: true },
            });
            expect(editSnapshot.headSha).toBe("handled-sha-123");
            expect(editSnapshot.baseSha).toBe("handled-sha-123");

            await harness.request().snapshotEdit.finalize({ snapshotId });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { activeSnapshot: { select: { headSha: true } } },
            });
            expect(branch.activeSnapshot?.headSha).toBe("handled-sha-123");
        });

        test("discard clears the pending pointer and marks the snapshot cancelled", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });

            await harness.request().snapshotEdit.discard({ snapshotId });

            const branch = await harness.db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { pendingSnapshotId: true },
            });
            expect(branch.pendingSnapshotId).toBeNull();

            // The snapshot is preserved for observability (reachable by id), marked cancelled.
            const snapshot = await harness.db.branchSnapshot.findUnique({
                where: { id: snapshotId },
                select: { status: true },
            });
            expect(snapshot?.status).toBe("cancelled");

            // But it is hidden from the user-facing history list.
            const history = await harness.services.branches.listSnapshots(branchId, harness.organizationId);
            expect(history.map((s) => s.id)).not.toContain(snapshotId);
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

        test("start conflicts when an edit session is already open", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            await harness.request().snapshotEdit.start({ branchId });

            const error = await harness
                .request()
                .snapshotEdit.start({ branchId })
                .catch((e: unknown) => e);

            expect(conflictCause(error)).toBeInstanceOf(EditSessionAlreadyOpenError);
        });

        test("get conflicts once the session's snapshot is closed", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.discard({ snapshotId });

            const error = await harness
                .request()
                .snapshotEdit.get({ snapshotId })
                .catch((e: unknown) => e);

            expect(conflictCause(error)).toBeInstanceOf(EditSessionSupersededError);
        });

        // ─── The branch's pending slot is shared with the analysis pipeline ──────────

        test("state reports the branch's editing state", async ({ harness }) => {
            const { branchId } = await createBranch(harness);

            expect(await harness.request().snapshotEdit.state({ branchId })).toEqual({ state: "none" });

            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });
            expect(await harness.request().snapshotEdit.state({ branchId })).toEqual({ state: "open", snapshotId });

            await pushCommit(harness, branchId);
            expect(await harness.request().snapshotEdit.state({ branchId })).toEqual({ state: "analysis-in-flight" });
        });

        test("start conflicts while an analysis owns the pending snapshot", async ({ harness }) => {
            const { branchId } = await createBranch(harness);
            await pushCommit(harness, branchId);

            const error = await harness
                .request()
                .snapshotEdit.start({ branchId })
                .catch((e: unknown) => e);

            expect(conflictCause(error)).toBeInstanceOf(AnalysisInFlightError);
        });

        test("a superseded session cannot read or write, and leaves the analysis snapshot untouched", async ({
            harness,
        }) => {
            const { branchId, folderId } = await createBranch(harness);
            const { snapshotId } = await harness.request().snapshotEdit.start({ branchId });
            await harness.request().snapshotEdit.addTest({
                snapshotId,
                name: "Doomed test",
                description: "Authored in a session a push is about to supersede.",
                plan: "Never committed",
                folderId,
            });
            const doomed = await harness.request().snapshotEdit.get({ snapshotId });
            // biome-ignore lint/style/noNonNullAssertion: just created
            const doomedTestCaseId = doomed.testSuite.testCases[0]!.id;

            const analysisSnapshotId = await pushCommit(harness, branchId);

            const calls = [
                () => harness.request().snapshotEdit.get({ snapshotId }),
                () =>
                    harness.request().snapshotEdit.addTest({
                        snapshotId,
                        name: "Another test",
                        description: "Should never reach the analysis snapshot.",
                        plan: "Rejected",
                        folderId,
                    }),
                () => harness.request().snapshotEdit.removeTest({ snapshotId, testCaseId: "any-test-case" }),
                () => harness.request().snapshotEdit.queueGenerations({ snapshotId }),
                () => harness.request().snapshotEdit.finalize({ snapshotId }),
                () => harness.request().snapshotEdit.discard({ snapshotId }),
            ];

            for (const call of calls) {
                const error = await call().catch((e: unknown) => e);
                expect(conflictCause(error)).toBeInstanceOf(EditSessionSupersededError);
            }

            // The analysis run still owns the branch and its snapshot is still open for the pipeline to settle.
            const analysisSnapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: analysisSnapshotId },
                select: { status: true, branch: { select: { pendingSnapshotId: true } } },
            });
            expect(analysisSnapshot.status).toBe("processing");
            expect(analysisSnapshot.branch.pendingSnapshotId).toBe(analysisSnapshotId);

            // Nothing the doomed session authored reached the analysis run's suite.
            const leaked = await harness.db.testCaseAssignment.count({
                where: { snapshotId: analysisSnapshotId, testCaseId: doomedTestCaseId },
            });
            expect(leaked).toBe(0);
        });

        test("the editor refuses a snapshot the analysis pipeline owns", async ({ harness }) => {
            const { branchId, folderId } = await createBranch(harness);
            const analysisSnapshotId = await pushCommit(harness, branchId);
            const assignmentsBefore = await harness.db.testCaseAssignment.count({
                where: { snapshotId: analysisSnapshotId },
            });

            const error = await harness
                .request()
                .snapshotEdit.addTest({
                    snapshotId: analysisSnapshotId,
                    name: "Smuggled test",
                    description: "Addressed straight at the analysis run's own snapshot.",
                    plan: "Rejected",
                    folderId,
                })
                .catch((e: unknown) => e);

            expect(conflictCause(error)).toBeInstanceOf(AnalysisInFlightError);
            const assignmentsAfter = await harness.db.testCaseAssignment.count({
                where: { snapshotId: analysisSnapshotId },
            });
            expect(assignmentsAfter).toBe(assignmentsBefore);
        });
    },
});
