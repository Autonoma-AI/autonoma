import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { ReviewReplayInput, ReviewReplayOutput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { withCodebaseForRun } from "../../codebase/resolve";
import { runReplayReview } from "../../review/replay/run";

export async function reviewReplay(input: ReviewReplayInput): Promise<ReviewReplayOutput> {
    const logger = rootLogger.child({ name: "reviewReplay", runId: input.runId });
    logger.info("Starting replay review");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        const result = await withCodebaseForRun(input.runId, {
            targetDirSeed: `run-review-${input.runId}`,
            body: (codebase) => runReplayReview(input.runId, { codebase }),
        });
        logger.info("Replay review completed", { status: result.status, verdict: result.verdict?.verdict });
        return { status: result.status, verdict: result.verdict };
    } catch (error) {
        logger.error("Replay review failed", error);

        try {
            await db.runReview.update({
                where: { runId: input.runId },
                data: { status: "failed" },
            });
        } catch (updateError) {
            logger.error("Failed to update review status to failed", updateError);
        }

        throw error;
    } finally {
        clearInterval(heartbeat);
    }
}
