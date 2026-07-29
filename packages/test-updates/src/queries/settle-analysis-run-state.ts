import type { PrismaClient, SnapshotStatus } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { AnalysisRunOutcome } from "@autonoma/types";
import { SnapshotNotPendingError } from "../snapshot-draft";
import { IncompleteGenerationsError, TestSuiteUpdater } from "../test-update-manager";

/**
 * Recorded on a generation the run finished without ever executing. Reaching settlement still `pending` means no
 * Investigator ever took ownership of it - a pipeline fault, not a test outcome - so the row is kept and marked
 * rather than deleted.
 */
const STRANDED_GENERATION_REASON = "The analysis run finished without ever executing this generation";

export interface SettleAnalysisRunStateInput {
    db: PrismaClient;
    snapshotId: string;
    outcome: AnalysisRunOutcome;
}

export interface SettleAnalysisRunStateResult {
    /** False when another actor already settled this run. Callers must skip side effects in that case. */
    settled: boolean;
    snapshotStatus?: SnapshotStatus;
    /** Generations this settlement marked failed: those a non-promoting outcome cut short, plus any left stranded. */
    generationsFailed: number;
    /** Suite changes discarded by a non-promoting outcome. */
    discardedChangeCount: number;
    /** The terminal outcome after handling a promotion failure, when this caller settled the run. */
    outcome?: AnalysisRunOutcome;
}

/**
 * Settle all database state owned by one authoritative analysis run.
 *
 * Snapshot settlement is the mutex. Once it succeeds, this caller owns the terminal job and generation writes;
 * callers that lose the race return a no-op result rather than throwing or repeating external side effects.
 *
 * Every generation this run leaves behind is MARKED, never removed. A generation is the anchor its test's
 * AnalysisClassification hangs off (the FK cascades), so deleting one erases the verdict the run reached about that
 * test - which reads downstream as a test that was never judged, and a checkpoint with nothing to report.
 */
export async function settleAnalysisRunState({
    db,
    snapshotId,
    outcome,
}: SettleAnalysisRunStateInput): Promise<SettleAnalysisRunStateResult> {
    const logger = rootLogger.child({ name: "settleAnalysisRunState", snapshotId });
    logger.info("Settling authoritative analysis run state", {
        snapshot: { snapshotId },
        extra: { outcome: outcome.kind },
    });
    const updater = await loadUpdater(db, snapshotId);
    if (updater == null) {
        logger.warn("Analysis run state was already settled", { snapshot: { snapshotId } });
        const result = unsettledResult();
        logger.info("Finished settling authoritative analysis run state", { snapshot: { snapshotId }, extra: result });
        return result;
    }

    // Before promoting: settle any generation the run left `pending`. Promotion refuses to run while incomplete
    // generations remain, and marking them is what earns that - deleting them instead would take each one's
    // AnalysisClassification with it (the FK cascades), erasing the verdict its test was judged on.
    const strandedGenerations =
        outcome.kind === "succeeded" ? await failStrandedGenerations(db, snapshotId, logger) : 0;

    const snapshotSettlement = await settleSnapshot(updater, outcome);
    if (snapshotSettlement == null) {
        logger.warn("Analysis run lost settlement race", { snapshot: { snapshotId } });
        const result = unsettledResult();
        logger.info("Finished settling authoritative analysis run state", { snapshot: { snapshotId }, extra: result });
        return result;
    }

    const settledOutcome = snapshotSettlement.outcome;
    const discardedChangeCount = settledOutcome.kind === "succeeded" ? 0 : (await updater.getChanges()).length;

    const failureReason =
        settledOutcome.kind === "failed"
            ? withDiscardedChangeCount(settledOutcome.reason, discardedChangeCount)
            : settledOutcome.kind === "superseded"
              ? settledOutcome.reason
              : undefined;
    const generationFailure = settledOutcome.kind === "succeeded" ? undefined : engineError(settledOutcome.reason);

    const generationsFailed = await db.$transaction(async (tx) => {
        const generations =
            generationFailure == null
                ? { count: 0 }
                : await tx.testGeneration.updateMany({
                      where: { snapshotId, status: { in: ["pending", "queued", "running"] } },
                      data: { status: "failed", failure: generationFailure },
                  });

        await tx.analysisJob.updateMany({
            where: { snapshotId, status: "running" },
            data:
                settledOutcome.kind === "succeeded"
                    ? { status: "completed", completedAt: new Date() }
                    : { status: "failed", failureReason, completedAt: new Date() },
        });

        return generations.count;
    });

    const result = {
        settled: true,
        snapshotStatus: snapshotSettlement.status,
        generationsFailed: generationsFailed + strandedGenerations,
        discardedChangeCount,
        outcome: settledOutcome,
    };
    logger.info("Authoritative analysis run state settled", { snapshot: { snapshotId }, extra: result });
    return result;
}

async function loadUpdater(db: PrismaClient, snapshotId: string): Promise<TestSuiteUpdater | undefined> {
    try {
        return await TestSuiteUpdater.continueUpdateBySnapshot({ db, snapshotId });
    } catch (error) {
        if (error instanceof SnapshotNotPendingError) return undefined;
        throw error;
    }
}

/**
 * Mark every generation the run left `pending` as failed. Each Investigator records its own generation's outcome, so
 * one still `pending` here was never owned by anything - log it, because after that it means a pipeline fault worth
 * chasing (a target no Investigator ran, or a child that died before its first activity).
 *
 * `queued`/`running` are deliberately untouched: that is work genuinely in flight, and it should keep blocking
 * promotion rather than being declared failed out from under itself.
 */
async function failStrandedGenerations(db: PrismaClient, snapshotId: string, logger: Logger): Promise<number> {
    const { count } = await db.testGeneration.updateMany({
        where: { snapshotId, status: "pending" },
        data: { status: "failed", failure: engineError(STRANDED_GENERATION_REASON) },
    });
    if (count > 0) {
        logger.warn("Analysis run reached settlement with generations that never ran", {
            snapshot: { snapshotId },
            extra: { strandedGenerations: count },
        });
    }
    return count;
}

async function settleSnapshot(
    updater: TestSuiteUpdater,
    outcome: AnalysisRunOutcome,
): Promise<{ status: SnapshotStatus; outcome: AnalysisRunOutcome } | undefined> {
    try {
        if (outcome.kind === "succeeded") {
            await updater.finalize();
            return { status: "active", outcome };
        }
        if (outcome.kind === "failed") {
            await updater.fail();
            return { status: "failed", outcome };
        }
        await updater.cancel();
        return { status: "cancelled", outcome };
    } catch (error) {
        if (error instanceof SnapshotNotPendingError) return undefined;
        if (!(error instanceof IncompleteGenerationsError)) throw error;
        const failureOutcome: AnalysisRunOutcome = { kind: "failed", reason: promotionFailureMessage(error) };
        await updater.fail();
        return { status: "failed", outcome: failureOutcome };
    }
}

function unsettledResult(): SettleAnalysisRunStateResult {
    return { settled: false, generationsFailed: 0, discardedChangeCount: 0 };
}

function withDiscardedChangeCount(reason: string, discardedChangeCount: number): string {
    if (discardedChangeCount === 0) return reason;
    return `${reason} (${discardedChangeCount} suite changes discarded; they will be recomputed on the next push)`;
}

function engineError(message: string): { kind: "engine_error"; message: string } {
    return { kind: "engine_error", message };
}

function promotionFailureMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Snapshot promotion failed";
}
