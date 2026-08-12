import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
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

    if (outcome.kind === "superseded") {
        logger.info("Finished settling superseded analysis run", { extra: { settled: true } });
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
