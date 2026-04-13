import { runDiffsAnalysis } from "@autonoma/job-diffs/run";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalyzeDiffsInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function analyzeDiffs(input: AnalyzeDiffsInput): Promise<void> {
    const logger = rootLogger.child({ name: "analyzeDiffs", branchId: input.branchId });
    logger.info("Starting diffs analysis");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runDiffsAnalysis(input.branchId);
        logger.info("Diffs analysis completed");
    } finally {
        clearInterval(heartbeat);
    }
}
