import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type { FinalizeAnalysisInput, FinalizeAnalysisOutput } from "@autonoma/workflow/activities";

/**
 * finalize stage - the terminal step, mirroring `finalizeDiffs`'s both-terminal shape:
 *
 * - `failureReason` present: the run failed upstream. Mark the AnalysisJob `failed` and do NOT promote.
 * - no failureReason: the happy path. Promote the branch's real pending snapshot through the proven
 *   `TestSuiteUpdater.finalize()` path, and mark the AnalysisJob `completed`.
 *
 * It handles only the run's lifecycle (promotion + job status): the verdict/counts were authored onto the report by
 * the Reporter one stage earlier. A promotion failure propagates - the workflow's catch calls finalize again with
 * the failureReason, marking the job failed rather than leaving it stuck `running`.
 */
export async function finalizeAnalysis(input: FinalizeAnalysisInput): Promise<FinalizeAnalysisOutput> {
    const { snapshotId, failureReason } = input;
    // snapshotId is bound to the observability context by the activity interceptor; only non-canonical fields go
    // in `extra`.
    const logger = rootLogger.child({ name: "finalizeAnalysis", extra: { failed: failureReason != null } });
    logger.info("finalize stage started");

    if (failureReason != null) {
        await markJob(snapshotId, { status: "failed", failureReason, completedAt: new Date() });
        logger.warn("Analysis run failed; marked AnalysisJob failed, snapshot not promoted", {
            extra: { failureReason },
        });
        return { promoted: false };
    }

    // Discard any generation still pending at finalize (a crashed Investigator's leftover): the run has already
    // classified every target, so a stray pending job must not block activation. queued/running still block.
    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId });
    await updater.finalize({ discardPendingGenerations: true });

    await markJob(snapshotId, { status: "completed", completedAt: new Date() });
    logger.info("finalize stage finished; AnalysisJob completed, snapshot promoted");
    return { promoted: true };
}

/**
 * Mark the AnalysisJob terminal. `updateMany` (not `update`) so a missing job (never expected - the trigger
 * always creates one) is a no-op rather than a throw - keeping finalize robust.
 */
async function markJob(
    snapshotId: string,
    data: { status: "completed" | "failed"; failureReason?: string; completedAt: Date },
): Promise<void> {
    await db.analysisJob.updateMany({ where: { snapshotId }, data });
}
