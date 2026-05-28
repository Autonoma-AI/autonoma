import { db } from "@autonoma/db";
import { runGenerationReview } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import type { ReviewGenerationInput, ReviewGenerationOutput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { withCodebaseForGeneration } from "../../codebase/resolve";

export async function reviewGeneration(input: ReviewGenerationInput): Promise<ReviewGenerationOutput> {
    const logger = rootLogger.child({ name: "reviewGeneration", generationId: input.generationId });
    logger.info("Starting generation review");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        const result = await withCodebaseForGeneration(input.generationId, {
            targetDirSeed: `gen-review-${input.generationId}`,
            body: (codebase) => runGenerationReview(input.generationId, { codebase }),
        });
        logger.info("Generation review completed", { status: result.status, verdict: result.verdict?.verdict });
        return { status: result.status, verdict: result.verdict };
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
