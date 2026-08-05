import type { PrismaClient } from "@autonoma/db";
import { TriggerSource } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { BranchAlreadyHasPendingSnapshotError } from "../snapshot-draft";
import { TestSuiteUpdater } from "../test-update-manager";
import { settleAnalysisRunState } from "./settle-analysis-run-state";

const SUPERSEDE_REASON = "Superseded by a newer analysis request";

export interface StartAnalysisRunParams {
    db: PrismaClient;
    logger: Logger;
    branchId: string;
    headSha: string;
    baseSha: string;
}

/**
 * A branch holds at most one pending snapshot, so this supersedes whatever run was in flight.
 *
 * Deliberately does NOT start the pipeline: the caller owns the run from here, which is what lets previewkit
 * decide the build on the result.
 */
export async function startAnalysisRun({
    db,
    logger,
    branchId,
    headSha,
    baseSha,
}: StartAnalysisRunParams): Promise<string> {
    // The branch owns the organization, so the job is scoped to whoever owns the snapshot rather than to whatever
    // the trigger believed.
    const { snapshotId, organizationId } = await openSnapshot({ db, logger, branchId, headSha, baseSha });
    await db.analysisJob.create({
        data: { snapshotId, organizationId, status: "running", startedAt: new Date() },
    });
    logger.info("Analysis run opened", {
        organization: { organizationId },
        branch: { branchId },
        snapshot: { snapshotId, headSha, baseSha },
    });
    return snapshotId;
}

async function openSnapshot({
    db,
    logger,
    branchId,
    headSha,
    baseSha,
}: StartAnalysisRunParams): Promise<{ snapshotId: string; organizationId: string }> {
    const start = () => TestSuiteUpdater.startUpdate({ db, branchId, source: TriggerSource.WEBHOOK, headSha, baseSha });

    try {
        const updater = await start();
        return { snapshotId: updater.snapshotId, organizationId: updater.organizationId };
    } catch (error) {
        if (!(error instanceof BranchAlreadyHasPendingSnapshotError)) throw error;

        const stale = await TestSuiteUpdater.continueUpdate({ db, branchId });
        logger.info("Superseding the pending snapshot and its in-flight pipeline", {
            branch: { branchId },
            snapshot: { snapshotId: stale.snapshotId },
        });
        await supersede({ db, logger, staleSnapshotId: stale.snapshotId });

        const updater = await start();
        return { snapshotId: updater.snapshotId, organizationId: updater.organizationId };
    }
}

/**
 * No workflow to cancel: runs are keyed on the branch with terminate-existing, so Temporal has already displaced
 * the predecessor. Termination runs no workflow code, though, so its own settlement never fires - hence this.
 */
async function supersede({
    db,
    logger,
    staleSnapshotId,
}: Pick<StartAnalysisRunParams, "db" | "logger"> & { staleSnapshotId: string }): Promise<void> {
    logger.info("Settling the superseded run", { snapshot: { snapshotId: staleSnapshotId } });
    await settleAnalysisRunState({
        db,
        snapshotId: staleSnapshotId,
        outcome: { kind: "superseded", reason: SUPERSEDE_REASON },
    });
}
