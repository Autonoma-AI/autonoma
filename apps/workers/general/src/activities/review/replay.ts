import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { runReplayReview } from "@autonoma/replay-reviewer/run";
import type { ReviewReplayInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function reviewReplay(input: ReviewReplayInput): Promise<void> {
    const logger = rootLogger.child({ name: "reviewReplay", runId: input.runId });
    logger.info("Starting replay review");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runReplayReview(input.runId, {
            skipIssueBugCreation: input.skipIssueBugCreation,
        });
        logger.info("Replay review completed");
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
