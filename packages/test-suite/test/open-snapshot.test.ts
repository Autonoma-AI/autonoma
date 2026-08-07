import { expect } from "vitest";
import { SnapshotNotOpenError, TestNotAssignedError, TestPlanMissingError } from "../src/errors";
import type { OpenSnapshot } from "../src/open-snapshot";
import { type SeedResult, type TestSuiteHarness, testSuiteSuite } from "./harness";

/** An open snapshot forked from an active source carrying one seeded test. */
async function openWithSeededTest(
    harness: TestSuiteHarness,
    seed: SeedResult,
): Promise<{ open: OpenSnapshot; seeded: { testCaseId: string; planId: string }; sourceSnapshotId: string }> {
    const seeded = await harness.createTestWithPlan(seed.organizationId, seed.applicationId, seed.folderId);
    const sourceSnapshotId = await harness.createActiveSnapshot(seed.branchId, {
        headSha: "source-head",
        assignments: [seeded],
    });
    const open = await harness.store.openSnapshot({
        branchId: seed.branchId,
        headSha: "new-head",
        source: { snapshotId: sourceSnapshotId },
        trigger: "WEBHOOK",
    });
    return { open, seeded, sourceSnapshotId };
}

testSuiteSuite({
    name: "OpenSnapshot suite edits",
    cases: (test) => {
        test("addTest mints the test case, its plan and the assignment together", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);

            const added = await open.addTest({
                name: "Checkout total",
                description: "The checkout total matches the cart",
                plan: "1. Open checkout.\n2. Assert the total.",
                folderId: seedResult.folderId,
            });

            expect(added.slug).toBe("checkout-total");
            const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: open.snapshotId, testCaseId: added.testCaseId } },
                include: { plan: true, testCase: true },
            });
            expect(assignment.planId).toBe(added.planId);
            expect(assignment.plan?.prompt).toContain("Assert the total");
            expect(assignment.testCase.slug).toBe(added.slug);
            // No edit ever starts a run.
            expect(await harness.db.testGeneration.count({ where: { snapshotId: open.snapshotId } })).toBe(0);
        });

        test("addTest mints a distinct slug when the name collides", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);
            const input = {
                name: "Checkout total",
                description: "claim",
                plan: "plan",
                folderId: seedResult.folderId,
            };

            const first = await open.addTest(input);
            const second = await open.addTest(input);

            expect(second.slug).not.toBe(first.slug);
            expect(second.slug).toMatch(/^checkout-total-/);
        });

        test("adoptTest assigns an existing test case with a freshly minted plan", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);
            const foreign = await harness.createTestWithPlan(
                seedResult.organizationId,
                seedResult.applicationId,
                seedResult.folderId,
            );

            const adopted = await open.adoptTest({ testCaseId: foreign.testCaseId, plan: "imported plan" });

            expect(adopted.planId).not.toBe(foreign.planId);
            const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: open.snapshotId, testCaseId: foreign.testCaseId } },
                include: { plan: true },
            });
            expect(assignment.plan?.prompt).toBe("imported plan");
        });

        test("revisePlan repoints the assignment at a new plan record", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);

            const revised = await open.revisePlan({ testCaseId: seeded.testCaseId, plan: "revised plan" });

            expect(revised.planId).not.toBe(seeded.planId);
            const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: open.snapshotId, testCaseId: seeded.testCaseId } },
            });
            expect(assignment.planId).toBe(revised.planId);
            // The old plan record survives untouched - a plan is never mutated in place.
            const original = await harness.db.testPlan.findUniqueOrThrow({ where: { id: seeded.planId } });
            expect(original.prompt).not.toBe("revised plan");
        });

        test("revisePlan refuses a test the snapshot does not assign", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);
            const foreign = await harness.createTestWithPlan(
                seedResult.organizationId,
                seedResult.applicationId,
                seedResult.folderId,
            );

            await expect(open.revisePlan({ testCaseId: foreign.testCaseId, plan: "x" })).rejects.toThrow(
                TestNotAssignedError,
            );
        });

        test("restorePlan makes a revise read as unchanged again", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);
            await open.revisePlan({ testCaseId: seeded.testCaseId, plan: "revised plan" });
            expect(await harness.store.changesSince(open.snapshotId)).toHaveLength(1);

            await open.restorePlan({ testCaseId: seeded.testCaseId, planId: seeded.planId });

            // The planId-keyed change computation sees the original record again: genuinely unchanged.
            expect(await harness.store.changesSince(open.snapshotId)).toEqual([]);
        });

        test("restorePlan refuses a plan that belongs to another test", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);
            const foreign = await harness.createTestWithPlan(
                seedResult.organizationId,
                seedResult.applicationId,
                seedResult.folderId,
            );
            await open.adoptTest({ testCaseId: foreign.testCaseId, plan: "adopted" });

            await expect(open.restorePlan({ testCaseId: seeded.testCaseId, planId: foreign.planId })).rejects.toThrow(
                /does not belong to test case/,
            );
        });

        test("dropTest removes the assignment and never the TestCase", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);

            await open.dropTest(seeded.testCaseId);
            // Idempotent: a second drop is a logged no-op.
            await open.dropTest(seeded.testCaseId);

            expect(
                await harness.db.testCaseAssignment.count({
                    where: { snapshotId: open.snapshotId, testCaseId: seeded.testCaseId },
                }),
            ).toBe(0);
            expect(await harness.db.testCase.count({ where: { id: seeded.testCaseId } })).toBe(1);
        });

        test("discardTest restores the source assignment, or unassigns a test added here", async ({
            harness,
            seedResult,
        }) => {
            const { open, seeded } = await openWithSeededTest(harness, seedResult);
            await open.revisePlan({ testCaseId: seeded.testCaseId, plan: "revised plan" });
            const added = await open.addTest({
                name: "Added here",
                description: "claim",
                plan: "plan",
                folderId: seedResult.folderId,
            });

            await open.discardTest(seeded.testCaseId);
            await open.discardTest(added.testCaseId);

            const restored = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: open.snapshotId, testCaseId: seeded.testCaseId } },
            });
            expect(restored.planId).toBe(seeded.planId);
            // The test added in this snapshot has nothing to restore: it ends unassigned, its TestCase surviving.
            expect(
                await harness.db.testCaseAssignment.count({
                    where: { snapshotId: open.snapshotId, testCaseId: added.testCaseId },
                }),
            ).toBe(0);
            expect(await harness.db.testCase.count({ where: { id: added.testCaseId } })).toBe(1);
        });

        test("withTransaction rolls every edit back together", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);

            await expect(
                open.withTransaction(async (tx) => {
                    await tx.revisePlan({ testCaseId: seeded.testCaseId, plan: "revised inside tx" });
                    await tx.dropTest(seeded.testCaseId);
                    throw new Error("boom");
                }),
            ).rejects.toThrow("boom");

            const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: open.snapshotId, testCaseId: seeded.testCaseId } },
            });
            expect(assignment.planId).toBe(seeded.planId);
        });
    },
});

testSuiteSuite({
    name: "OpenSnapshot.startRun",
    cases: (test) => {
        test("resolves the pinned plan and starts one pending run", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);

            const { runId, scenarioId } = await open.startRun(seeded.testCaseId);

            expect(scenarioId).toBeUndefined();
            const run = await harness.db.testGeneration.findUniqueOrThrow({ where: { id: runId } });
            expect(run.status).toBe("pending");
            expect(run.testPlanId).toBe(seeded.planId);
            expect(run.snapshotId).toBe(open.snapshotId);
            expect(run.organizationId).toBe(seedResult.organizationId);
        });

        test("returns the scenario the pinned plan carries", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);
            const scenario = await harness.db.scenario.create({
                data: {
                    name: `Scenario ${harness.next()}`,
                    applicationId: seedResult.applicationId,
                    organizationId: seedResult.organizationId,
                },
            });
            const withScenario = await harness.createTestWithPlan(
                seedResult.organizationId,
                seedResult.applicationId,
                seedResult.folderId,
                { scenarioId: scenario.id },
            );
            await open.adoptTest({
                testCaseId: withScenario.testCaseId,
                plan: "scenario plan",
                scenarioId: scenario.id,
            });

            const { scenarioId } = await open.startRun(withScenario.testCaseId);

            expect(scenarioId).toBe(scenario.id);
        });

        test("a second startRun for one test starts a second run without touching the first", async ({
            harness,
            seedResult,
        }) => {
            const { open, seeded } = await openWithSeededTest(harness, seedResult);

            const first = await open.startRun(seeded.testCaseId);
            const second = await open.startRun(seeded.testCaseId);

            expect(second.runId).not.toBe(first.runId);
            const firstRun = await harness.db.testGeneration.findUniqueOrThrow({ where: { id: first.runId } });
            expect(firstRun.status).toBe("pending");
        });

        test("refuses an unassigned test and a planless assignment", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);
            const unassigned = await harness.createTestWithPlan(
                seedResult.organizationId,
                seedResult.applicationId,
                seedResult.folderId,
            );
            await expect(open.startRun(unassigned.testCaseId)).rejects.toThrow(TestNotAssignedError);

            const planless = await harness.db.testCase.create({
                data: {
                    name: "Planless",
                    slug: `planless-${harness.next()}`,
                    organizationId: seedResult.organizationId,
                    applicationId: seedResult.applicationId,
                    folderId: seedResult.folderId,
                },
            });
            await harness.db.testCaseAssignment.create({
                data: { snapshotId: open.snapshotId, testCaseId: planless.id },
            });
            await expect(open.startRun(planless.id)).rejects.toThrow(TestPlanMissingError);
        });
    },
});

testSuiteSuite({
    name: "OpenSnapshot terminals",
    cases: (test) => {
        test("promote activates the snapshot, supersedes the previous active and moves the pointers", async ({
            harness,
            seedResult,
        }) => {
            const { open, sourceSnapshotId } = await openWithSeededTest(harness, seedResult);

            expect(await open.promote()).toBe(true);

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: open.snapshotId } });
            expect(snapshot.status).toBe("active");
            const source = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: sourceSnapshotId } });
            expect(source.status).toBe("superseded");
            const branch = await harness.db.branch.findUniqueOrThrow({ where: { id: seedResult.branchId } });
            expect(branch.activeSnapshotId).toBe(open.snapshotId);
            expect(branch.pendingSnapshotId).toBeNull();
        });

        test("promotion is unconditional on what did or did not run", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);
            const { runId } = await open.startRun(seeded.testCaseId);

            // A run nobody executed does not veto promotion, and promotion does not rewrite it.
            expect(await open.promote()).toBe(true);
            const run = await harness.db.testGeneration.findUniqueOrThrow({ where: { id: runId } });
            expect(run.status).toBe("pending");
        });

        test("exactly one concurrent terminal wins", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open } = await openWithSeededTest(harness, seedResult);
            const reopened = await harness.store.reopen(open.snapshotId);

            const [promoted, cancelled] = await Promise.all([open.promote(), reopened.cancel("superseded by test")]);

            expect([promoted, cancelled].filter(Boolean)).toHaveLength(1);
            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: open.snapshotId } });
            expect(snapshot.status).toBe(promoted ? "active" : "cancelled");
        });

        test("fail marks the runs the outcome cut short, with the reason", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);
            const { runId } = await open.startRun(seeded.testCaseId);
            const settled = await harness.db.testGeneration.create({
                data: {
                    testPlanId: seeded.planId,
                    snapshotId: open.snapshotId,
                    organizationId: seedResult.organizationId,
                    status: "success",
                },
            });

            expect(await open.fail("the Reporter crashed")).toBe(true);

            const snapshot = await harness.db.branchSnapshot.findUniqueOrThrow({ where: { id: open.snapshotId } });
            expect(snapshot.status).toBe("failed");
            const interrupted = await harness.db.testGeneration.findUniqueOrThrow({ where: { id: runId } });
            expect(interrupted.status).toBe("failed");
            expect(interrupted.failure).toEqual({ kind: "engine_error", message: "the Reporter crashed" });
            // A run that already settled keeps its own outcome.
            const untouched = await harness.db.testGeneration.findUniqueOrThrow({ where: { id: settled.id } });
            expect(untouched.status).toBe("success");
            // Assignments survive for observability.
            expect(await harness.db.testCaseAssignment.count({ where: { snapshotId: open.snapshotId } })).toBe(1);
        });

        test("a terminal snapshot rejects every later edit", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, seeded } = await openWithSeededTest(harness, seedResult);
            expect(await open.cancel("newer push")).toBe(true);

            // The stale handle from before the terminal cannot write through it.
            await expect(open.revisePlan({ testCaseId: seeded.testCaseId, plan: "late edit" })).rejects.toThrow(
                SnapshotNotOpenError,
            );
            await expect(open.dropTest(seeded.testCaseId)).rejects.toThrow(SnapshotNotOpenError);
            await expect(open.startRun(seeded.testCaseId)).rejects.toThrow(SnapshotNotOpenError);
            await expect(
                open.addTest({ name: "Late", description: "claim", plan: "plan", folderId: seedResult.folderId }),
            ).rejects.toThrow(SnapshotNotOpenError);

            const assignment = await harness.db.testCaseAssignment.findUniqueOrThrow({
                where: { snapshotId_testCaseId: { snapshotId: open.snapshotId, testCaseId: seeded.testCaseId } },
            });
            expect(assignment.planId).toBe(seeded.planId);
        });

        test("cancel frees the branch for a new snapshot", async ({ harness }) => {
            const seedResult = await harness.seedContext();
            const { open, sourceSnapshotId } = await openWithSeededTest(harness, seedResult);
            expect(await open.cancel("superseded")).toBe(true);

            // A cancel promotes nothing, so the next run forks from the same active snapshot this one did.
            const next = await harness.store.openSnapshot({
                branchId: seedResult.branchId,
                headSha: "head-2",
                source: { snapshotId: sourceSnapshotId },
                trigger: "WEBHOOK",
            });
            expect(next.snapshotId).not.toBe(open.snapshotId);
        });
    },
});
