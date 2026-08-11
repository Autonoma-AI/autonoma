import type { PrismaClient } from "@autonoma/db";
import { expect } from "vitest";
import { computeSuiteChanges } from "../src/queries/suite-changes";
import { type SnapshotComparison, summarizeSuiteChanges } from "../src/queries/summarize-changes";
import { type SeedResult, testSuiteSuite } from "./harness";

/**
 * Seeds a three-snapshot chain covering every comparison outcome:
 *
 * s0 (no predecessor): kept, dropped
 * s1: kept (same plan), dropped (new plan -> updated), introduced (-> added)
 * s2: kept, introduced (dropped gone -> removed)
 */
async function seedChain(db: PrismaClient, fixture: SeedResult) {
    // Test cases are unique per application, and the suite seeds one application for all cases.
    const suffix = crypto.randomUUID().slice(0, 8);
    const kept = await createTestCase(db, fixture, `kept-${suffix}`);
    const dropped = await createTestCase(db, fixture, `dropped-${suffix}`);
    const introduced = await createTestCase(db, fixture, `introduced-${suffix}`);

    const keptPlan = await createPlan(db, fixture, kept, "kept plan");
    const droppedPlanV1 = await createPlan(db, fixture, dropped, "dropped plan v1");
    const droppedPlanV2 = await createPlan(db, fixture, dropped, "dropped plan v2");
    const introducedPlan = await createPlan(db, fixture, introduced, "introduced plan");

    const s0 = await createSnapshot(db, fixture.branchId);
    await createAssignment(db, s0, kept, keptPlan);
    await createAssignment(db, s0, dropped, droppedPlanV1);

    const s1 = await createSnapshot(db, fixture.branchId, s0);
    await createAssignment(db, s1, kept, keptPlan);
    await createAssignment(db, s1, dropped, droppedPlanV2);
    await createAssignment(db, s1, introduced, introducedPlan);

    const s2 = await createSnapshot(db, fixture.branchId, s1);
    await createAssignment(db, s2, kept, keptPlan);
    await createAssignment(db, s2, introduced, introducedPlan);

    return { s0, s1, s2 };
}

async function createTestCase(db: PrismaClient, fixture: SeedResult, slug: string): Promise<string> {
    const testCase = await db.testCase.create({
        data: {
            applicationId: fixture.applicationId,
            organizationId: fixture.organizationId,
            folderId: fixture.folderId,
            slug,
            name: slug,
        },
        select: { id: true },
    });
    return testCase.id;
}

async function createPlan(db: PrismaClient, fixture: SeedResult, testCaseId: string, prompt: string): Promise<string> {
    const plan = await db.testPlan.create({
        data: { testCaseId, organizationId: fixture.organizationId, prompt },
        select: { id: true },
    });
    return plan.id;
}

async function createSnapshot(db: PrismaClient, branchId: string, prevSnapshotId?: string): Promise<string> {
    const snapshot = await db.branchSnapshot.create({
        data: { branchId, source: "MANUAL", status: "active", prevSnapshotId },
        select: { id: true },
    });
    return snapshot.id;
}

async function createAssignment(
    db: PrismaClient,
    snapshotId: string,
    testCaseId: string,
    planId: string,
): Promise<void> {
    await db.testCaseAssignment.create({ data: { snapshotId, testCaseId, planId } });
}

/** The per-snapshot path this batched query replaced, kept as the reference implementation. */
async function summarizeOneByOne(db: PrismaClient, comparisons: readonly SnapshotComparison[]) {
    const changeLists = await Promise.all(
        comparisons.map((c) => computeSuiteChanges(db, c.snapshotId, c.prevSnapshotId)),
    );
    return new Map(
        comparisons.map((c, index) => {
            const changes = changeLists[index] ?? [];
            return [
                c.snapshotId,
                {
                    added: changes.filter((change) => change.type === "added").length,
                    removed: changes.filter((change) => change.type === "removed").length,
                    updated: changes.filter((change) => change.type === "updated").length,
                },
            ];
        }),
    );
}

testSuiteSuite({
    name: "summarizeSuiteChanges",
    cases: (test) => {
        test("counts added, removed and updated per snapshot across a chain", async ({ harness, seedResult }) => {
            const { s0, s1, s2 } = await seedChain(harness.db, seedResult);

            const summaries = await summarizeSuiteChanges(harness.db, [
                { snapshotId: s2, prevSnapshotId: s1 },
                { snapshotId: s1, prevSnapshotId: s0 },
                { snapshotId: s0 },
            ]);

            // First snapshot on the branch: every assignment is new.
            expect(summaries.get(s0)).toEqual({ added: 2, removed: 0, updated: 0 });
            expect(summaries.get(s1)).toEqual({ added: 1, removed: 0, updated: 1 });
            expect(summaries.get(s2)).toEqual({ added: 0, removed: 1, updated: 0 });
        });

        test("matches the per-snapshot summary, including a predecessor absent from the list", async ({
            harness,
            seedResult,
        }) => {
            const { s1, s2 } = await seedChain(harness.db, seedResult);

            // s1 is omitted from the comparisons but is still s2's predecessor - the case a
            // cancelled snapshot or investigation twin produces in the history list.
            const comparisons: SnapshotComparison[] = [{ snapshotId: s2, prevSnapshotId: s1 }];

            const [batched, oneByOne] = await Promise.all([
                summarizeSuiteChanges(harness.db, comparisons),
                summarizeOneByOne(harness.db, comparisons),
            ]);

            expect(batched.get(s2)).toEqual({ added: 0, removed: 1, updated: 0 });
            expect(batched).toEqual(oneByOne);
        });

        test("treats a snapshot with no assignments as having no changes", async ({ harness, seedResult }) => {
            const empty = await createSnapshot(harness.db, seedResult.branchId);

            const summaries = await summarizeSuiteChanges(harness.db, [{ snapshotId: empty }]);

            expect(summaries.get(empty)).toEqual({ added: 0, removed: 0, updated: 0 });
        });

        test("returns an empty map for an empty comparison list", async ({ harness }) => {
            expect(await summarizeSuiteChanges(harness.db, [])).toEqual(new Map());
        });
    },
});
