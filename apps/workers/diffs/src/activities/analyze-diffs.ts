import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalyzeDiffsInput, AnalyzeDiffsOutput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { runDiffsAnalysis } from "../analysis/run-analysis";
import { withCodebaseForSnapshot } from "../codebase/resolve";

export async function analyzeDiffs({ snapshotId }: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput> {
    const logger = rootLogger.child({ name: "analyzeDiffs" });
    logger.info("Starting diffs analysis");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "analyzing", startedAt: new Date() },
        });

        const { replays, reasoning, conversationUrl } = await withCodebaseForSnapshot(snapshotId, {
            targetDirSeed: `analysis-${snapshotId}`,
            body: (codebase) => runDiffsAnalysis({ snapshotId, codebase }),
        });

        await db.diffsJob.update({
            where: { snapshotId },
            data: {
                analysisReasoning: reasoning,
                analysisConversationUrl: conversationUrl,
                status: "replaying",
            },
        });

        logger.info("Diffs analysis activity completed", {
            extra: { preparedRuns: replays.length, reasoning: reasoning.slice(0, 200) },
        });

        return { replays };
    } catch (error) {
        await db.diffsJob.update({
            where: { snapshotId },
            data: {
                status: "failed",
                failureReason: error instanceof Error ? error.message : String(error),
                completedAt: new Date(),
            },
        });
        throw error;
    } finally {
        clearInterval(heartbeat);
    }
}
