import { logger as rootLogger } from "@autonoma/logger";
import { type AnalysisRunOutcome, isNonCompletingOutcome } from "@autonoma/types";
import type { AnalysisGitHub } from "./analysis-github";

interface SettleAnalysisGitHubInput {
    snapshotId: string;
    outcome: AnalysisRunOutcome;
    github: AnalysisGitHub;
}

/** Apply best-effort GitHub effects after authoritative analysis state is already terminal. */
export async function settleAnalysisGitHub({ snapshotId, outcome, github }: SettleAnalysisGitHubInput): Promise<void> {
    const logger = rootLogger.child({ name: "settleAnalysisGitHub", snapshotId });
    logger.info("Settling analysis GitHub effects", { extra: { outcome: outcome.kind } });
    // A non-completing (superseded/cancelled) run has no result anyone consumes, so it never reaches GitHub.
    // `settleAnalysisRun` already returns before calling this for both; the guard keeps that contract local should
    // another caller appear.
    if (isNonCompletingOutcome(outcome)) {
        logger.info("Skipping GitHub effects for non-completing analysis run", { extra: { outcome: outcome.kind } });
        logger.info("Finished settling analysis GitHub effects");
        return;
    }

    try {
        await github.conclude(outcome);
    } catch (error) {
        logger.error("Analysis merge-gate settlement failed after database settlement", { extra: { err: error } });
    }

    // A failed run still gets a comment (could-not-complete); only a superseded run - handled above - writes nothing.
    try {
        await github.comment(outcome);
    } catch (error) {
        logger.error("Analysis PR-comment settlement failed after database settlement", { extra: { err: error } });
    }
    logger.info("Finished settling analysis GitHub effects");
}
