import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalyzeDiffsInput, AnalyzeDiffsOutput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { runDiffsAnalysis } from "../analysis/run-analysis";
import { withCodebaseForSnapshot } from "../codebase/resolve";
import { SnapshotDependencyManifestPinner } from "../grounding/pin-dependency-manifest";

export async function analyzeDiffs({ snapshotId }: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput> {
    const logger = rootLogger.child({ name: "analyzeDiffs" });
    logger.info("Starting diffs analysis");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "analyzing", startedAt: new Date() },
        });

        // First grounding for this snapshot: pin the deployed dependency manifest
        // so every downstream agent (both reviewers, every healing iteration)
        // grounds against the exact multi-repo commit state that was live,
        // immune to a later redeploy.
        await new SnapshotDependencyManifestPinner(db).ensurePinned(snapshotId);

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
