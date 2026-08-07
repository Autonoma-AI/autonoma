import { expect } from "vitest";
import { PriorRuns } from "../../src/analysis/db/prior-runs";
import { priorRunsSuite } from "./prior-runs-harness";

const DAY_ONE = new Date("2026-01-01T10:00:00Z");
const DAY_TWO = new Date("2026-01-02T10:00:00Z");
const DAY_THREE = new Date("2026-01-03T10:00:00Z");

priorRunsSuite({
    name: "PriorRuns.getHistory",
    cases: (test) => {
        test("builds the baseline from the verdicts earlier analyses reached", async ({ harness }) => {
            const seeded = await harness.seedTest();
            await harness.recordAnalyzedRun({ test: seeded, iterations: ["passed"], at: DAY_ONE });
            await harness.recordAnalyzedRun({ test: seeded, iterations: ["client_bug"], at: DAY_TWO });
            const now = await harness.recordAnalyzedRun({ test: seeded, iterations: ["passed"], at: DAY_THREE });

            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: seeded.applicationId,
                testSlug: seeded.slug,
                currentSnapshotId: now,
            });

            expect(history.totalRecent).toBe(2);
            expect(history.everPassed).toBe(true);
            expect(history.passedCount).toBe(1);
            expect(history.mostRecentPassDay).toBe("2026-01-01");
            expect(history.recent).toEqual([
                { day: "2026-01-02", category: "client_bug" },
                { day: "2026-01-01", category: "passed" },
            ]);
            expect(PriorRuns.formatBaseline(history)).not.toContain("NEVER been executed");
        });

        test("does not read a finished engine run as evidence the app behaved", async ({ harness }) => {
            const seeded = await harness.seedTest();
            // Every generation the harness writes is `status: success`, while the verdicts say the app was
            // never exercised. The baseline has to report the verdicts.
            await harness.recordAnalyzedRun({ test: seeded, iterations: ["environment_failure"], at: DAY_ONE });
            await harness.recordAnalyzedRun({ test: seeded, iterations: ["engine_artifact"], at: DAY_TWO });
            const now = await harness.recordAnalyzedRun({ test: seeded, iterations: ["client_bug"], at: DAY_THREE });

            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: seeded.applicationId,
                testSlug: seeded.slug,
                currentSnapshotId: now,
            });

            expect(history.totalRecent).toBe(2);
            expect(history.everPassed).toBe(false);
            expect(history.passedCount).toBe(0);
            expect(history.mostRecentPassDay).toBeUndefined();
        });

        test("counts only the verdict a self-healed run stands behind, not its superseded iterations", async ({
            harness,
        }) => {
            const seeded = await harness.seedTest();
            await harness.recordAnalyzedRun({
                test: seeded,
                iterations: ["plan_mismatch", "plan_mismatch", "passed"],
                at: DAY_ONE,
            });
            const now = await harness.recordAnalyzedRun({ test: seeded, iterations: ["client_bug"], at: DAY_TWO });

            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: seeded.applicationId,
                testSlug: seeded.slug,
                currentSnapshotId: now,
            });

            expect(history.totalRecent).toBe(1);
            expect(history.passedCount).toBe(1);
            expect(history.recent).toEqual([{ day: "2026-01-01", category: "passed" }]);
        });

        test("excludes the analysis run under judgment, including its own earlier self-heal iteration", async ({
            harness,
        }) => {
            const seeded = await harness.seedTest();
            // A self-heal re-run: iteration 1 already filed a verdict against the snapshot being analyzed now.
            const now = await harness.recordAnalyzedRun({ test: seeded, iterations: ["plan_mismatch"], at: DAY_TWO });

            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: seeded.applicationId,
                testSlug: seeded.slug,
                currentSnapshotId: now,
            });

            expect(history.totalRecent).toBe(0);
            expect(PriorRuns.formatBaseline(history)).toContain("NEVER been executed");
        });

        test("ignores a run that never reached a verdict", async ({ harness }) => {
            const seeded = await harness.seedTest();
            await harness.recordUnjudgedRun(seeded, DAY_ONE);
            const now = await harness.recordAnalyzedRun({ test: seeded, iterations: ["client_bug"], at: DAY_TWO });

            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: seeded.applicationId,
                testSlug: seeded.slug,
                currentSnapshotId: now,
            });

            expect(history.totalRecent).toBe(0);
        });

        test("honours the before bound the eval freezes a baseline with", async ({ harness }) => {
            const seeded = await harness.seedTest();
            await harness.recordAnalyzedRun({ test: seeded, iterations: ["passed"], at: DAY_ONE });
            await harness.recordAnalyzedRun({ test: seeded, iterations: ["passed"], at: DAY_THREE });
            const now = await harness.recordAnalyzedRun({ test: seeded, iterations: ["client_bug"], at: DAY_TWO });

            // Replaying the DAY_TWO classification must not see the pass that only happened on DAY_THREE.
            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: seeded.applicationId,
                testSlug: seeded.slug,
                currentSnapshotId: now,
                before: DAY_TWO,
            });

            expect(history.totalRecent).toBe(1);
            expect(history.mostRecentPassDay).toBe("2026-01-01");
        });

        test("never lets another tenant's app with the same slug establish the baseline", async ({ harness }) => {
            const mine = await harness.seedTest("shared-slug");
            const theirs = await harness.seedTest("shared-slug");
            await harness.recordAnalyzedRun({ test: theirs, iterations: ["passed"], at: DAY_ONE });
            await harness.recordAnalyzedRun({ test: mine, iterations: ["client_bug"], at: DAY_TWO });
            const now = await harness.recordAnalyzedRun({ test: mine, iterations: ["client_bug"], at: DAY_THREE });

            const history = await new PriorRuns(harness.db).getHistory({
                applicationId: mine.applicationId,
                testSlug: mine.slug,
                currentSnapshotId: now,
            });

            expect(history.totalRecent).toBe(1);
            expect(history.everPassed).toBe(false);
        });
    },
});
