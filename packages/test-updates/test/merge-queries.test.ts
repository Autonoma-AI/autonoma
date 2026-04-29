import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { applyMergePlanImports } from "../src/queries/apply-merge-plan-imports";
import { buildMergeClassifierInputs } from "../src/queries/build-merge-classifier-inputs";
import { findMergeSourceSnapshot } from "../src/queries/find-merge-source-snapshot";
import { testUpdateSuite } from "./harness";

async function createSnapshot(
    db: PrismaClient,
    branchId: string,
    options: { status?: "processing" | "active"; headSha?: string } = {},
): Promise<string> {
    const snapshot = await db.branchSnapshot.create({
        data: {
            branchId,
            source: "MANUAL",
            status: options.status ?? "processing",
            headSha: options.headSha,
        },
        select: { id: true },
    });

    if (options.status === "active") {
        await db.branch.update({
            where: { id: branchId },
            data: { activeSnapshotId: snapshot.id },
        });
    }
    return snapshot.id;
}

async function createTestCase(
    db: PrismaClient,
    params: { applicationId: string; organizationId: string; folderId: string; slug: string; name: string },
): Promise<string> {
    const testCase = await db.testCase.create({
        data: {
            applicationId: params.applicationId,
            organizationId: params.organizationId,
            folderId: params.folderId,
            slug: params.slug,
            name: params.name,
        },
        select: { id: true },
    });
    return testCase.id;
}

async function createPlan(
    db: PrismaClient,
    params: { testCaseId: string; organizationId: string; prompt: string },
): Promise<string> {
    const plan = await db.testPlan.create({
        data: {
            testCaseId: params.testCaseId,
            organizationId: params.organizationId,
            prompt: params.prompt,
        },
        select: { id: true },
    });
    return plan.id;
}

async function createAssignment(
    db: PrismaClient,
    params: {
        snapshotId: string;
        testCaseId: string;
        planId?: string;
        stepsId?: string;
    },
): Promise<string> {
    const assignment = await db.testCaseAssignment.create({
        data: {
            snapshotId: params.snapshotId,
            testCaseId: params.testCaseId,
            planId: params.planId,
            stepsId: params.stepsId,
        },
        select: { id: true },
    });
    return assignment.id;
}

testUpdateSuite({
    name: "findMergeSourceSnapshot",
    cases: (test) => {
        test("returns null when no branch is registered for the PR", async ({
            harness,
            seedResult: { applicationId },
        }) => {
            const result = await findMergeSourceSnapshot({
                db: harness.db,
                applicationId,
                prNumber: 9999,
                sourceHeadSha: "deadbeef",
            });
            expect(result).toBeNull();
        });

        test("returns null when branch exists but no active snapshot is pinned at the SHA", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 123 });
            await createSnapshot(harness.db, branchId, { status: "processing", headSha: "abc123" });

            const result = await findMergeSourceSnapshot({
                db: harness.db,
                applicationId,
                prNumber: 123,
                sourceHeadSha: "abc123",
            });
            expect(result).toBeNull();
        });

        test("returns the pinned snapshot with baseSnapshotId when an active snapshot exists at the exact SHA", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            const baseSnapshotId = await createSnapshot(harness.db, mainBranchId, {
                status: "active",
                headSha: "main-base",
            });

            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 42 });
            await harness.db.branch.update({ where: { id: branchId }, data: { baseSnapshotId } });
            const snapshotId = await createSnapshot(harness.db, branchId, { status: "active", headSha: "feat-sha" });

            const result = await findMergeSourceSnapshot({
                db: harness.db,
                applicationId,
                prNumber: 42,
                sourceHeadSha: "feat-sha",
            });

            expect(result).not.toBeNull();
            expect(result!.snapshotId).toBe(snapshotId);
            expect(result!.branchId).toBe(branchId);
            expect(result!.prNumber).toBe(42);
            expect(result!.headSha).toBe("feat-sha");
            expect(result!.baseSnapshotId).toBe(baseSnapshotId);
        });

        test("falls back to activeSnapshot.prevSnapshotId when baseSnapshotId is unset", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 43 });
            const prevSnapshotId = await createSnapshot(harness.db, branchId, {
                status: "active",
                headSha: "prev-sha",
            });
            const activeSnapshot = await harness.db.branchSnapshot.create({
                data: {
                    branchId,
                    source: "MANUAL",
                    status: "active",
                    headSha: "feat-sha",
                    prevSnapshotId,
                },
                select: { id: true },
            });
            await harness.db.branch.update({
                where: { id: branchId },
                data: { activeSnapshotId: activeSnapshot.id },
            });

            const result = await findMergeSourceSnapshot({
                db: harness.db,
                applicationId,
                prNumber: 43,
                sourceHeadSha: "feat-sha",
            });

            expect(result).not.toBeNull();
            expect(result!.baseSnapshotId).toBe(prevSnapshotId);
        });

        test("returns baseSnapshotId null when neither baseSnapshotId nor prev snapshot is available", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 44 });
            await createSnapshot(harness.db, branchId, { status: "active", headSha: "feat-sha" });

            const result = await findMergeSourceSnapshot({
                db: harness.db,
                applicationId,
                prNumber: 44,
                sourceHeadSha: "feat-sha",
            });

            expect(result).not.toBeNull();
            expect(result!.baseSnapshotId).toBeNull();
        });

        test("does not match a different SHA on the same branch", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const branchId = await harness.createBranch(organizationId, applicationId, { prNumber: 7 });
            await createSnapshot(harness.db, branchId, { status: "active", headSha: "real-sha" });

            const result = await findMergeSourceSnapshot({
                db: harness.db,
                applicationId,
                prNumber: 7,
                sourceHeadSha: "different-sha",
            });
            expect(result).toBeNull();
        });
    },
});

testUpdateSuite({
    name: "buildMergeClassifierInputs",
    cases: (test) => {
        test("assembles target + source legs with the base snapshot's assignment as merge-base", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            const featBranchId = await harness.createBranch(organizationId, applicationId, { prNumber: 1 });

            // TestCase present in both main and feat
            const tc = await createTestCase(harness.db, {
                applicationId,
                organizationId,
                folderId,
                slug: "login",
                name: "Login",
            });

            const baseMainSnapshot = await createSnapshot(harness.db, mainBranchId, {
                status: "active",
                headSha: "main-base",
            });
            const plan1 = await createPlan(harness.db, { testCaseId: tc, organizationId, prompt: "v1" });
            await createAssignment(harness.db, {
                snapshotId: baseMainSnapshot,
                testCaseId: tc,
                planId: plan1,
            });

            // feat branch's merge-base is that main snapshot
            await harness.db.branch.update({
                where: { id: featBranchId },
                data: { baseSnapshotId: baseMainSnapshot },
            });

            // feat branch snapshot branched from main-base, then modified the plan
            const featSnapshot = await createSnapshot(harness.db, featBranchId, {
                status: "active",
                headSha: "feat-head",
            });
            const plan2 = await createPlan(harness.db, { testCaseId: tc, organizationId, prompt: "v2" });
            await createAssignment(harness.db, {
                snapshotId: featSnapshot,
                testCaseId: tc,
                planId: plan2,
            });

            // Target snapshot (current main, unchanged relative to base)
            const targetSnapshot = await createSnapshot(harness.db, mainBranchId, {
                status: "processing",
                headSha: "main-head",
            });
            await createAssignment(harness.db, {
                snapshotId: targetSnapshot,
                testCaseId: tc,
                planId: plan1,
            });

            const rows = await buildMergeClassifierInputs({
                db: harness.db,
                targetSnapshotId: targetSnapshot,
                sources: [
                    {
                        snapshotId: featSnapshot,
                        branchName: "feat/login",
                        prNumber: 1,
                        baseSnapshotId: baseMainSnapshot,
                    },
                ],
            });

            expect(rows).toHaveLength(1);
            const row = rows[0]!;
            expect(row.slug).toBe("login");
            expect(row.target?.planId).toBe(plan1);
            expect(row.sources).toHaveLength(1);
            expect(row.sources[0]!.leg?.planId).toBe(plan2);
            expect(row.sources[0]!.base?.planId).toBe(plan1);
        });

        test("leaves base null when the source has no baseSnapshotId", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            const featBranchId = await harness.createBranch(organizationId, applicationId, { prNumber: 2 });

            const tc = await createTestCase(harness.db, {
                applicationId,
                organizationId,
                folderId,
                slug: "signup",
                name: "Signup",
            });

            const featSnapshot = await createSnapshot(harness.db, featBranchId, {
                status: "active",
                headSha: "feat-head",
            });
            const featPlan = await createPlan(harness.db, { testCaseId: tc, organizationId, prompt: "v1" });
            await createAssignment(harness.db, { snapshotId: featSnapshot, testCaseId: tc, planId: featPlan });

            const targetSnapshot = await createSnapshot(harness.db, mainBranchId, {
                status: "processing",
                headSha: "main-head",
            });

            const rows = await buildMergeClassifierInputs({
                db: harness.db,
                targetSnapshotId: targetSnapshot,
                sources: [
                    {
                        snapshotId: featSnapshot,
                        branchName: "feat/signup",
                        prNumber: 2,
                        baseSnapshotId: null,
                    },
                ],
            });

            expect(rows).toHaveLength(1);
            expect(rows[0]!.sources[0]!.base).toBeNull();
            expect(rows[0]!.sources[0]!.leg?.planId).toBe(featPlan);
        });
    },
});

testUpdateSuite({
    name: "applyMergePlanImports",
    cases: (test) => {
        test("updates an existing target assignment in place", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            const featBranchId = await harness.createBranch(organizationId, applicationId, { prNumber: 10 });

            const tc = await createTestCase(harness.db, {
                applicationId,
                organizationId,
                folderId,
                slug: "checkout",
                name: "Checkout",
            });

            const mainPlan = await createPlan(harness.db, { testCaseId: tc, organizationId, prompt: "main" });
            const featPlan = await createPlan(harness.db, { testCaseId: tc, organizationId, prompt: "feat" });

            const targetSnapshot = await createSnapshot(harness.db, mainBranchId, { status: "processing" });
            const existingTargetAssignmentId = await createAssignment(harness.db, {
                snapshotId: targetSnapshot,
                testCaseId: tc,
                planId: mainPlan,
            });

            const sourceSnapshot = await createSnapshot(harness.db, featBranchId, { status: "active" });
            const sourceAssignmentId = await createAssignment(harness.db, {
                snapshotId: sourceSnapshot,
                testCaseId: tc,
                planId: featPlan,
            });

            const result = await applyMergePlanImports({
                db: harness.db,
                targetSnapshotId: targetSnapshot,
                imports: [{ sourceAssignmentId }],
            });

            expect(result).toHaveLength(1);
            expect(result[0]!.operation).toBe("updated");
            expect(result[0]!.targetAssignmentId).toBe(existingTargetAssignmentId);
            expect(result[0]!.planId).toBe(featPlan);

            const reloaded = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { id: existingTargetAssignmentId },
                select: { planId: true },
            });
            expect(reloaded.planId).toBe(featPlan);
        });

        test("creates a new target assignment when none exists", async ({
            harness,
            seedResult: { organizationId, applicationId, folderId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            const featBranchId = await harness.createBranch(organizationId, applicationId, { prNumber: 11 });

            const tc = await createTestCase(harness.db, {
                applicationId,
                organizationId,
                folderId,
                slug: "new-flow",
                name: "New flow",
            });
            const featPlan = await createPlan(harness.db, { testCaseId: tc, organizationId, prompt: "new" });

            const targetSnapshot = await createSnapshot(harness.db, mainBranchId, { status: "processing" });
            const sourceSnapshot = await createSnapshot(harness.db, featBranchId, { status: "active" });
            const sourceAssignmentId = await createAssignment(harness.db, {
                snapshotId: sourceSnapshot,
                testCaseId: tc,
                planId: featPlan,
            });

            const result = await applyMergePlanImports({
                db: harness.db,
                targetSnapshotId: targetSnapshot,
                imports: [{ sourceAssignmentId }],
            });

            expect(result).toHaveLength(1);
            expect(result[0]!.operation).toBe("created");
            expect(result[0]!.planId).toBe(featPlan);

            const created = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: targetSnapshot, testCaseId: tc } },
                select: { id: true, planId: true },
            });
            expect(created.id).toBe(result[0]!.targetAssignmentId);
            expect(created.planId).toBe(featPlan);
        });

        test("skips imports whose source assignment cannot be resolved", async ({
            harness,
            seedResult: { organizationId, applicationId },
        }) => {
            const mainBranchId = await harness.createBranch(organizationId, applicationId);
            const targetSnapshot = await createSnapshot(harness.db, mainBranchId, { status: "processing" });

            const result = await applyMergePlanImports({
                db: harness.db,
                targetSnapshotId: targetSnapshot,
                imports: [{ sourceAssignmentId: "does-not-exist" }],
            });
            expect(result).toEqual([]);
        });
    },
});
