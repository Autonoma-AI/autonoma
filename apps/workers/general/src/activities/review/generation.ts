import { db } from "@autonoma/db";
import { runGenerationReview } from "@autonoma/generation-reviewer/run";
import { logger as rootLogger } from "@autonoma/logger";
import type { ReviewGenerationInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function reviewGeneration(input: ReviewGenerationInput): Promise<void> {
    const logger = rootLogger.child({ name: "reviewGeneration", generationId: input.generationId });
    logger.info("Starting generation review");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runGenerationReview(input.generationId);
        logger.info("Generation review completed");
    } catch (error) {
        logger.error("Generation review failed", error);

        try {
            await db.generationReview.update({
                where: { generationId: input.generationId },
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
