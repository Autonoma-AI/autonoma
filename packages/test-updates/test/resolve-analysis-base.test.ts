import { expect } from "vitest";
import { resolveAnalysisBase } from "../src/queries/resolve-analysis-base";
import { type TestUpdatesHarness, testUpdateSuite } from "./harness";

/** A branch whose active snapshot sits at `headSha` - the state the precedence prefers. */
async function branchAnalyzedAt(harness: TestUpdatesHarness, headSha: string): Promise<string> {
    const organizationId = await harness.createOrg();
    const applicationId = await harness.createApp(organizationId);
    const branchId = await harness.createBranch(organizationId, applicationId);

    const snapshot = await harness.db.branchSnapshot.create({
        data: { branchId, source: "MANUAL", status: "active", headSha },
    });
    await harness.db.branch.update({ where: { id: branchId }, data: { activeSnapshotId: snapshot.id } });
    return branchId;
}

/**
 * The API trigger and the run's own `openAnalysisRun` both ask this, and a disagreement between them would either
 * drop a run or open an empty one - so these pin the precedence itself, not either caller.
 */
testUpdateSuite({
    name: "resolveAnalysisBase",
    cases: (test) => {
        test("prefers the branch's active-snapshot head over the caller's fallback", async ({ harness }) => {
            const branchId = await branchAnalyzedAt(harness, "snapshot-head");

            const base = await resolveAnalysisBase({
                db: harness.db,
                branchId,
                headSha: "new-head",
                fallbackBaseSha: "pr-base",
            });

            expect(base.baseSha).toBe("snapshot-head");
            expect(base.alreadyAnalyzed).toBe(false);
        });

        test("reports an already-analyzed head when it matches the active snapshot", async ({ harness }) => {
            const branchId = await branchAnalyzedAt(harness, "same-head");

            const base = await resolveAnalysisBase({
                db: harness.db,
                branchId,
                headSha: "same-head",
                fallbackBaseSha: "pr-base",
            });

            expect(base.alreadyAnalyzed).toBe(true);
        });

        // A PR branch on its first run: the base can only come from the trigger, which read it off GitHub.
        test("falls back to the caller's base for a branch that has never been analyzed", async ({
            harness,
            seedResult,
        }) => {
            const base = await resolveAnalysisBase({
                db: harness.db,
                branchId: seedResult.branchId,
                headSha: "new-head",
                fallbackBaseSha: "pr-base",
            });

            expect(base.baseSha).toBe("pr-base");
            expect(base.alreadyAnalyzed).toBe(false);
        });

        // Main passes no fallback, so a repo with no baseline snapshot has nothing to diff against.
        test("reports no base at all when neither source has one", async ({ harness, seedResult }) => {
            const base = await resolveAnalysisBase({ db: harness.db, branchId: seedResult.branchId, headSha: "head" });

            expect(base.baseSha).toBeUndefined();
            expect(base.alreadyAnalyzed).toBe(false);
        });
    },
});
