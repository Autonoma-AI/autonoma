import type { CostCollector } from "@autonoma/ai";
import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";

/**
 * Persist an investigation activity's metered orchestration AI spend as `AiCostRecord` rows,
 * keyed on the (detached) investigation snapshot.
 *
 * Investigation orchestration calls (select/classify/diagnose/merge) are tied to neither a user
 * generation nor a run, so they hang off `investigationSnapshotId`. The workflow total is then
 * `SUM(cost_microdollars) WHERE investigation_snapshot_id = ?`.
 *
 * Each cost-producing activity has its own {@link CostCollector} and its own snapshotId, so it
 * flushes its own records at activity end - no cross-activity threading. Investigation activities
 * run with `maximumAttempts: 1`, so there is no retry path that could double-insert.
 */
export async function persistInvestigationCosts(
    db: PrismaClient,
    snapshotId: string,
    costCollector: CostCollector,
    logger: Logger,
): Promise<void> {
    const records = costCollector.getRecords();
    if (records.length === 0) {
        logger.debug("No investigation AI costs to persist");
        return;
    }

    await db.aiCostRecord.createMany({
        data: records.map((record) => ({
            investigationSnapshotId: snapshotId,
            model: record.model,
            tag: record.tag,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            reasoningTokens: record.reasoningTokens,
            cacheReadTokens: record.cacheReadTokens,
            costMicrodollars: record.costMicrodollars,
        })),
    });

    const costMicrodollars = records.reduce((sum, record) => sum + record.costMicrodollars, 0);
    logger.info("Persisted investigation AI costs", { extra: { count: records.length, costMicrodollars } });
}
