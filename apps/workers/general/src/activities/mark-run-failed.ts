import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { MarkRunFailedInput } from "@autonoma/workflow/activities";

export async function markRunFailed(input: MarkRunFailedInput): Promise<void> {
    const logger = rootLogger.child({
        name: "markRunFailed",
        runId: input.runId,
    });
    logger.info("Marking run as failed", { reason: input.reason });

    const run = await db.run.findUnique({
        where: { id: input.runId },
        select: { status: true },
    });

    if (run == null) {
        logger.warn("Run not found, skipping");
        return;
    }

    const UPDATABLE_STATUSES = ["pending", "running"] as const;
    const canUpdate = (UPDATABLE_STATUSES as readonly string[]).includes(run.status);
    if (!canUpdate) {
        logger.info("Run already in terminal state, skipping", { currentStatus: run.status });
        return;
    }

    try {
        await db.run.update({
            where: { id: input.runId },
            data: {
                status: "failed",
                reasoning: input.reason ?? "Replay execution failed unexpectedly.",
            },
        });
        logger.info("Run marked as failed");
    } catch (error) {
        logger.error("Failed to mark run as failed", error);
        throw error;
    }
}
