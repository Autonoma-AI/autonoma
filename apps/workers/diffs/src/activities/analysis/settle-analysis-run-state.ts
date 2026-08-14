import { AnalysisStore } from "@autonoma/analysis";
import type { PrismaClient, SnapshotStatus } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { type OpenSnapshot, SnapshotNotFoundError, SnapshotNotOpenError, TestSuiteStore } from "@autonoma/test-suite";
import type { AnalysisRunOutcome } from "@autonoma/types";

export interface SettleAnalysisRunStateInput {
    db: PrismaClient;
    snapshotId: string;
    outcome: AnalysisRunOutcome;
}

export interface SettleAnalysisRunStateResult {
    /** False when another actor already settled this run. Callers must skip side effects in that case. */
    settled: boolean;
    snapshotStatus?: SnapshotStatus;
    /** Suite changes discarded by a non-promoting outcome. */
    discardedChangeCount: number;
}

/**
 * Settle all database state owned by one authoritative analysis run: the snapshot terminal (the suite module's
 * compare-and-swap, which IS the settlement mutex) and the `AnalysisJob`'s terminal status.
 *
 * Promotion is unconditional on what did or did not run - a coverage gap is the Reporter's fact to report, not a
 * promotion veto. A non-promoting terminal marks the runs it cut short as failed (inside the suite module's
 * terminal) and reports how many suite changes the outcome discarded.
 *
 * Callers that lose the settlement race get a no-op result rather than an exception, and must skip their external
 * side effects.
 */
export async function settleAnalysisRunState({
    db,
    snapshotId,
    outcome,
}: SettleAnalysisRunStateInput): Promise<SettleAnalysisRunStateResult> {
    const logger = rootLogger.child({ name: "settleAnalysisRunState" });
    logger.info("Settling authoritative analysis run state", {
        snapshot: { snapshotId },
        extra: { outcome: outcome.kind },
    });

    const store = new TestSuiteStore(db);
    const snapshot = await reopenSettling(store, snapshotId);
    if (snapshot == null) {
        logger.warn("Analysis run state was already settled", { snapshot: { snapshotId } });
        return { settled: false, discardedChangeCount: 0 };
    }

    const won = await applyTerminal(snapshot, outcome);
    if (!won) {
        logger.warn("Analysis run lost settlement race", { snapshot: { snapshotId } });
        return { settled: false, discardedChangeCount: 0 };
    }

    const discardedChangeCount = outcome.kind === "succeeded" ? 0 : (await store.changesSince(snapshotId)).length;
    const closed = await new AnalysisStore(db)
        .forAnalysis(snapshotId)
        .close(withDiscardedChanges(outcome, discardedChangeCount));
    if (!closed) {
        logger.warn("Analysis job was already closed; the snapshot terminal still won", {
            snapshot: { snapshotId },
        });
    }

    const result: SettleAnalysisRunStateResult = {
        settled: true,
        snapshotStatus: terminalStatus(outcome),
        discardedChangeCount,
    };
    logger.info("Authoritative analysis run state settled", { snapshot: { snapshotId }, extra: { ...result } });
    return result;
}

async function reopenSettling(store: TestSuiteStore, snapshotId: string): Promise<OpenSnapshot | undefined> {
    try {
        return await store.reopen(snapshotId);
    } catch (error) {
        if (error instanceof SnapshotNotOpenError || error instanceof SnapshotNotFoundError) return undefined;
        throw error;
    }
}

async function applyTerminal(snapshot: OpenSnapshot, outcome: AnalysisRunOutcome): Promise<boolean> {
    if (outcome.kind === "succeeded") return snapshot.promote();
    if (outcome.kind === "failed") return snapshot.fail(outcome.reason);
    // superseded | cancelled - both cancel the snapshot terminal; the result lives on in a later run, or nobody
    // wants it (the application was deleted/unlinked).
    return snapshot.cancel(outcome.reason);
}

function terminalStatus(outcome: AnalysisRunOutcome): SnapshotStatus {
    if (outcome.kind === "succeeded") return "active";
    if (outcome.kind === "failed") return "failed";
    // superseded | cancelled
    return "cancelled";
}

/**
 * A failed outcome explains itself with what the run discarded - a suite fact, composed here because the analysis
 * module never reads suite changes. A superseded run keeps its plain reason: its changes live on in the run that
 * displaced it.
 */
function withDiscardedChanges(outcome: AnalysisRunOutcome, discardedChangeCount: number): AnalysisRunOutcome {
    if (outcome.kind !== "failed" || discardedChangeCount === 0) return outcome;
    return {
        kind: "failed",
        reason: `${outcome.reason} (${discardedChangeCount} suite changes discarded; they will be recomputed on the next push)`,
    };
}
