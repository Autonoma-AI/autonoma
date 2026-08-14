import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { isNonCompletingOutcome } from "@autonoma/types";
import type { SettleAnalysisRunInput, SettleAnalysisRunOutput } from "@autonoma/workflow/activities";
import { getAnalysisStore } from "../../services";
import { LiveAnalysisGitHub } from "./live-analysis-github";
import { settleAnalysisGitHub } from "./settle-analysis-github";
import { settleAnalysisRunState } from "./settle-analysis-run-state";

/** Settle the durable analysis run before optionally notifying GitHub. */
export async function settleAnalysisRun(input: SettleAnalysisRunInput): Promise<SettleAnalysisRunOutput> {
    const { snapshotId, outcome } = input;
    const logger = rootLogger.child({ name: "settleAnalysisRun", snapshotId });
    logger.info("Settling analysis run", { extra: { outcome: outcome.kind } });

    const result = await settleAnalysisRunState({ db, snapshotId, outcome });
    if (!result.settled) {
        logger.warn("Analysis run was already settled; skipping GitHub effects", {
            extra: { outcome: outcome.kind, settled: false },
        });
        logger.info("Finished settling analysis run", { extra: { settled: false } });
        return result;
    }

    const durationMs = await resolveDurationMs(snapshotId);
    if (outcome.kind === "failed") {
        logger.fatal("Analysis run failed and was settled", {
            extra: { outcome: outcome.kind, durationMs, discardedChangeCount: result.discardedChangeCount },
        });
    } else {
        logger.info("Analysis run database state settled", { extra: { outcome: outcome.kind, durationMs } });
    }

    // A non-completing (superseded/cancelled) run's result nobody consumes, so it never touches GitHub: there is no
    // verdict to post and no merge gate to conclude for a displaced or abandoned run.
    if (isNonCompletingOutcome(outcome)) {
        logger.info("Finished settling non-completing analysis run", {
            extra: { outcome: outcome.kind, settled: true },
        });
        return result;
    }

    await settleAnalysisGitHub({
        snapshotId,
        outcome,
        github: new LiveAnalysisGitHub(snapshotId),
    });
    logger.info("Finished settling analysis run", { extra: { settled: true } });
    return result;
}

async function resolveDurationMs(snapshotId: string): Promise<number | undefined> {
    const lifecycle = await getAnalysisStore().forAnalysis(snapshotId).lifecycle();
    if (lifecycle?.startedAt == null) return undefined;
    return Date.now() - lifecycle.startedAt.getTime();
}
