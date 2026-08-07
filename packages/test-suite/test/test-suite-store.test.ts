import { expect } from "vitest";
import {
    BranchAlreadyOpenError,
    NoSnapshotBaseError,
    SnapshotNotFoundError,
    SnapshotNotOpenError,
    SourceMovedError,
} from "../src/errors";
import { testSuiteSuite } from "./harness";

testSuiteSuite({
    name: "TestSuiteStore.openSnapshot",
    cases: (test) => {
        test("copies the source suite forward and derives baseSha from the source's head", async ({ harness }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const testA = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const testB = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const sourceSnapshotId = await harness.createActiveSnapshot(branchId, {
                headSha: "source-head",
                assignments: [testA, testB],
            });

            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "new-head",
                source: { snapshotId: sourceSnapshotId },
                trigger: "WEBHOOK",
            });

            expect(open.headSha).toBe("new-head");
            expect(open.baseSha).toBe("source-head");

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({
                where: { id: open.snapshotId },
                include: { testCaseAssignments: true },
            });
            expect(snapshot.status).toBe("processing");
            expect(snapshot.headSha).toBe("new-head");
            expect(snapshot.baseSha).toBe("source-head");
            expect(snapshot.prevSnapshotId).toBe(sourceSnapshotId);
            // Copy-forward fidelity: same tests, same plan RECORDS (consecutive snapshots share plan rows).
            const copied = new Map(snapshot.testCaseAssignments.map((a) => [a.testCaseId, a.planId]));
            expect(copied.get(testA.testCaseId)).toBe(testA.planId);
            expect(copied.get(testB.testCaseId)).toBe(testB.planId);

            const branch = await harness.db.branch.findUniqueOrThrow({ where: { id: branchId } });
            expect(branch.pendingSnapshotId).toBe(open.snapshotId);
            // The source is the branch's own snapshot, so no fork point is pinned.
            expect(branch.baseSnapshotId).toBeNull();
        });

        test("forking from another branch's snapshot pins it as the fork point", async ({ harness }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const mainBranchId = await harness.createBranch(organizationId, applicationId, { asMain: true });
            const mainTest = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const mainSnapshotId = await harness.createActiveSnapshot(mainBranchId, {
                headSha: "main-head",
                assignments: [mainTest],
            });

            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "pr-head",
                source: { snapshotId: mainSnapshotId, fallbackBaseSha: "pr-base" },
                trigger: "WEBHOOK",
            });

            // A foreign source contributes the suite, never the base: main's snapshot head can lag the real fork
            // point when merges to main are not analyzed, so the diff is taken against the caller's PR base.
            expect(open.baseSha).toBe("pr-base");
            const branch = await harness.db.branch.findUniqueOrThrow({ where: { id: branchId } });
            expect(branch.baseSnapshotId).toBe(mainSnapshotId);
            const suite = await open.read();
            expect(suite.testCases.map((testCase) => testCase.id)).toEqual([mainTest.testCaseId]);
        });

        test("falls back to the caller's base sha only when the source snapshot records no head", async ({
            harness,
        }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const seeded = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const sourceSnapshotId = await harness.createActiveSnapshot(branchId, { assignments: [seeded] });

            await expect(
                harness.store.openSnapshot({
                    branchId,
                    headSha: "new-head",
                    source: { snapshotId: sourceSnapshotId },
                    trigger: "WEBHOOK",
                }),
            ).rejects.toThrow(NoSnapshotBaseError);

            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "new-head",
                source: { snapshotId: sourceSnapshotId, fallbackBaseSha: "onboarding-base" },
                trigger: "WEBHOOK",
            });
            expect(open.baseSha).toBe("onboarding-base");
        });

        test("opens with no prior snapshot from a free-floating base sha", async ({ harness }) => {
            const { branchId } = await harness.seedContext();
            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "head-1",
                source: { noPriorSnapshot: { baseSha: "base-1" } },
                trigger: "WEBHOOK",
            });

            expect(open.baseSha).toBe("base-1");
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: open.snapshotId } });
            expect(snapshot.prevSnapshotId).toBeNull();
            expect((await open.read()).testCases).toEqual([]);
        });

        test("refuses a source the branch has promoted past", async ({ harness }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const original = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const sourceSnapshotId = await harness.createActiveSnapshot(branchId, {
                headSha: "s0-head",
                assignments: [original],
            });

            // A push resolves its source while the previous run is still in flight.
            const resolved = await harness.store.resolveSource({ branchId, headSha: "new-head" });
            expect(resolved.source).toMatchObject({ snapshotId: sourceSnapshotId });

            // That run then settles: it authored a test and promoted, so the branch's active snapshot moves.
            const inFlight = await harness.store.openSnapshot({
                branchId,
                headSha: "in-flight-head",
                source: { snapshotId: sourceSnapshotId },
                trigger: "WEBHOOK",
            });
            await inFlight.addTest({
                name: "Authored by the run that promoted",
                description: "Would be lost if the stale source were honoured.",
                plan: "1. Do the thing.",
                folderId,
            });
            expect(await inFlight.promote()).toBe(true);

            // Opening on the pre-promotion source would fork from a superseded snapshot, silently dropping the
            // test above and taking the diff from the older head.
            await expect(
                harness.store.openSnapshot({
                    branchId,
                    headSha: "new-head",
                    // biome-ignore lint/style/noNonNullAssertion: asserted above
                    source: resolved.source!,
                    trigger: "WEBHOOK",
                }),
            ).rejects.toThrow(SourceMovedError);

            // Re-resolving is what the caller does next, and it now forks from the promoted snapshot.
            const reresolved = await harness.store.resolveSource({ branchId, headSha: "new-head" });
            expect(reresolved.source).toMatchObject({ snapshotId: inFlight.snapshotId });
            const reopened = await harness.store.openSnapshot({
                branchId,
                headSha: "new-head",
                // biome-ignore lint/style/noNonNullAssertion: asserted above
                source: reresolved.source!,
                trigger: "WEBHOOK",
            });
            expect(reopened.baseSha).toBe("in-flight-head");
            const suite = await reopened.read();
            expect(suite.testCases.map((testCase) => testCase.name)).toContain("Authored by the run that promoted");
            expect(suite.testCases.map((testCase) => testCase.id)).toContain(original.testCaseId);
        });

        test("refuses to open while a snapshot is already open, naming it", async ({ harness }) => {
            const { branchId } = await harness.seedContext();
            const first = await harness.store.openSnapshot({
                branchId,
                headSha: "head-1",
                source: { noPriorSnapshot: { baseSha: "base-1" } },
                trigger: "WEBHOOK",
            });

            const second = harness.store.openSnapshot({
                branchId,
                headSha: "head-2",
                source: { noPriorSnapshot: { baseSha: "base-2" } },
                trigger: "WEBHOOK",
            });
            await expect(second).rejects.toThrow(BranchAlreadyOpenError);
            await expect(second).rejects.toMatchObject({ pendingSnapshotId: first.snapshotId });
        });

        test("copies the source snapshot's scenario schema and recipe versions", async ({ harness }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const seeded = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const sourceSnapshotId = await harness.createActiveSnapshot(branchId, {
                headSha: "source-head",
                assignments: [seeded],
            });
            const scenario = await harness.db.scenario.create({
                data: {
                    name: `Seeded scenario ${harness.next()}`,
                    applicationId,
                    organizationId,
                    description: "one user",
                },
            });
            const schemaSnapshot = await harness.db.scenarioSchemaSnapshot.create({
                data: {
                    applicationId,
                    snapshotId: sourceSnapshotId,
                    structureJson: { entities: [] },
                    fingerprint: "fp-1",
                },
            });
            const sourceRecipe = await harness.db.scenarioRecipeVersion.create({
                data: {
                    scenarioId: scenario.id,
                    snapshotId: sourceSnapshotId,
                    schemaSnapshotId: schemaSnapshot.id,
                    applicationId,
                    organizationId,
                    scenarioNameSnapshot: "Seeded scenario",
                    description: "the recipe as authored",
                    fingerprint: "fp-1",
                    validationStatus: "valid",
                    validationMethod: "static",
                    validationPhase: "authoring",
                    validationUpMs: 120,
                    validationDownMs: 45,
                    fixtureJson: { users: 1 },
                },
            });

            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "new-head",
                source: { snapshotId: sourceSnapshotId },
                trigger: "WEBHOOK",
            });

            const copiedSchema = await harness.db.scenarioSchemaSnapshot.findUniqueOrThrow({
                where: { applicationId_snapshotId: { applicationId, snapshotId: open.snapshotId } },
            });
            expect(copiedSchema.id).not.toBe(schemaSnapshot.id);
            expect(copiedSchema).toMatchObject({
                applicationId,
                structureJson: { entities: [] },
                fingerprint: "fp-1",
            });

            const copiedRecipes = await harness.db.scenarioRecipeVersion.findMany({
                where: { snapshotId: open.snapshotId },
            });
            expect(copiedRecipes).toHaveLength(1);
            // A column that stopped being copied fails here rather than going missing on the next snapshot.
            const sourceColumns = await harness.db.scenarioRecipeVersion.findUniqueOrThrow({
                where: { id: sourceRecipe.id },
                omit: { id: true, snapshotId: true, schemaSnapshotId: true, createdAt: true, updatedAt: true },
            });
            expect(copiedRecipes[0]).toMatchObject(sourceColumns);
            expect(copiedRecipes[0]?.id).not.toBe(sourceRecipe.id);
            expect(copiedRecipes[0]?.schemaSnapshotId).toBe(copiedSchema.id);
        });
    },
});

testSuiteSuite({
    name: "TestSuiteStore.resolveSource",
    cases: (test) => {
        test("prefers the branch's own active snapshot", async ({ harness }) => {
            const { organizationId, applicationId, branchId } = await harness.seedContext();
            const mainBranchId = await harness.createBranch(organizationId, applicationId, { asMain: true });
            await harness.createActiveSnapshot(mainBranchId, { headSha: "main-head" });
            const ownSnapshotId = await harness.createActiveSnapshot(branchId, { headSha: "own-head" });

            const resolved = await harness.store.resolveSource({ branchId, headSha: "new-head" });

            expect(resolved.source).toEqual({ snapshotId: ownSnapshotId, fallbackBaseSha: undefined });
            expect(resolved.baseSha).toBe("own-head");
            expect(resolved.alreadyAnalyzed).toBe(false);
        });

        test("falls back to main's active snapshot for a branch with none", async ({ harness }) => {
            const { organizationId, applicationId, branchId } = await harness.seedContext();
            const mainBranchId = await harness.createBranch(organizationId, applicationId, { asMain: true });
            const mainSnapshotId = await harness.createActiveSnapshot(mainBranchId, { headSha: "main-head" });

            const resolved = await harness.store.resolveSource({
                branchId,
                headSha: "pr-head",
                fallbackBaseSha: "pr-base",
            });

            expect(resolved.source).toEqual({ snapshotId: mainSnapshotId, fallbackBaseSha: "pr-base" });
            // The inherited snapshot contributes the suite; the diff base stays the branch's own PR base.
            expect(resolved.baseSha).toBe("pr-base");
        });

        test("reports an already-analyzed head", async ({ harness }) => {
            const { branchId } = await harness.seedContext();
            await harness.createActiveSnapshot(branchId, { headSha: "head-1" });

            const resolved = await harness.store.resolveSource({ branchId, headSha: "head-1" });

            expect(resolved.alreadyAnalyzed).toBe(true);
        });

        test("yields no source at all when there is no snapshot anywhere and no fallback", async ({ harness }) => {
            const { branchId } = await harness.seedContext();
            const resolved = await harness.store.resolveSource({ branchId, headSha: "head-1" });

            expect(resolved.source).toBeUndefined();
            expect(resolved.baseSha).toBeUndefined();
            expect(resolved.alreadyAnalyzed).toBe(false);
        });
    },
});

testSuiteSuite({
    name: "TestSuiteStore.reopen / read / changesSince",
    cases: (test) => {
        test("reopen refuses a missing or settled snapshot with the precise condition", async ({ harness }) => {
            const { branchId } = await harness.seedContext();
            await expect(harness.store.reopen("nope")).rejects.toThrow(SnapshotNotFoundError);

            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "head-1",
                source: { noPriorSnapshot: { baseSha: "base-1" } },
                trigger: "WEBHOOK",
            });
            expect(await open.promote()).toBe(true);

            const reopening = harness.store.reopen(open.snapshotId);
            await expect(reopening).rejects.toThrow(SnapshotNotOpenError);
            await expect(reopening).rejects.toMatchObject({ status: "active" });
        });

        test("changesSince reports added, updated and removed tests relative to the source", async ({ harness }) => {
            const { organizationId, applicationId, branchId, folderId } = await harness.seedContext();
            const kept = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const revised = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const dropped = await harness.createTestWithPlan(organizationId, applicationId, folderId);
            const sourceSnapshotId = await harness.createActiveSnapshot(branchId, {
                headSha: "source-head",
                assignments: [kept, revised, dropped],
            });

            const open = await harness.store.openSnapshot({
                branchId,
                headSha: "new-head",
                source: { snapshotId: sourceSnapshotId },
                trigger: "WEBHOOK",
            });
            const added = await open.addTest({
                name: "Brand new",
                description: "a new claim",
                plan: "1. Do the new thing.",
                folderId,
            });
            await open.revisePlan({ testCaseId: revised.testCaseId, plan: "revised plan" });
            await open.dropTest(dropped.testCaseId);

            const changes = await harness.store.changesSince(open.snapshotId);
            const byType = new Map(changes.map((change) => [change.type, change]));
            expect(changes).toHaveLength(3);
            expect(byType.get("added")?.testCaseId).toBe(added.testCaseId);
            expect(byType.get("updated")?.testCaseId).toBe(revised.testCaseId);
            expect(byType.get("removed")?.testCaseId).toBe(dropped.testCaseId);
        });
    },
});
