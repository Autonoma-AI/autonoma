import type { PrismaClient, SnapshotStatus } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalysisRunOutcome } from "@autonoma/types";
import { SnapshotNotPendingError } from "../snapshot-draft";
import { IncompleteGenerationsError, TestSuiteUpdater } from "../test-update-manager";

export interface SettleAnalysisRunStateInput {
    db: PrismaClient;
    snapshotId: string;
    outcome: AnalysisRunOutcome;
}

export interface SettleAnalysisRunStateResult {
    /** False when another actor already settled this run. Callers must skip side effects in that case. */
    settled: boolean;
    snapshotStatus?: SnapshotStatus;
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
        generationsFailed,
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

async function settleSnapshot(
    updater: TestSuiteUpdater,
    outcome: AnalysisRunOutcome,
): Promise<{ status: SnapshotStatus; outcome: AnalysisRunOutcome } | undefined> {
    try {
        if (outcome.kind === "succeeded") {
            await updater.finalize({ discardPendingGenerations: true });
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
