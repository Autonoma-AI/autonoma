import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { MarkGenerationFailedInput } from "@autonoma/workflow/activities";

export async function markGenerationFailed(input: MarkGenerationFailedInput): Promise<void> {
    const logger = rootLogger.child({
        name: "markGenerationFailed",
        generationId: input.testGenerationId,
    });
    logger.info("Marking generation as failed", { reason: input.reason });

    const generation = await db.testGeneration.findUnique({
        where: { id: input.testGenerationId },
        select: { status: true },
    });

    if (generation == null) {
        logger.warn("Generation not found, skipping");
        return;
    }

    const UPDATABLE_STATUSES = ["pending", "queued", "running"] as const;
    const canUpdate = (UPDATABLE_STATUSES as readonly string[]).includes(generation.status);
    if (!canUpdate) {
        logger.info("Generation already in terminal state, skipping", { currentStatus: generation.status });
        return;
    }

    try {
        await db.testGeneration.update({
            where: { id: input.testGenerationId },
            data: {
                status: "failed",
                reasoning:
                    input.reason ?? "Scenario setup failed. Check your scenario webhook configuration and try again.",
            },
        });
        logger.info("Generation marked as failed");
    } catch (error) {
        logger.error("Failed to mark generation as failed", error);
        throw error;
    }
}
