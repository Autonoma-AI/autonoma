import type { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { printCostSummary as printSharedCostSummary } from "@autonoma/engine";
import { logger as rootLogger } from "@autonoma/logger";

const logger = rootLogger.child({ name: "cost-summary" });

export async function printCostSummary(costCollector: CostCollector) {
    printSharedCostSummary(costCollector);
    await persistCostRecords(costCollector);
}

async function persistCostRecords(costCollector: CostCollector) {
    const records = costCollector.getRecords();
    if (records.length === 0) return;

    const generation = await db.testGeneration.findFirst({ select: { id: true } });
    if (generation == null) {
        logger.warn("No test generation found in DB - skipping cost record persistence");
        return;
    }

    await db.aiCostRecord.createMany({
        data: records.map((record) => ({
            generationId: generation.id,
            model: record.model,
            tag: record.tag,
            inputTokens: record.inputTokens,
            outputTokens: record.outputTokens,
            reasoningTokens: record.reasoningTokens,
            cacheReadTokens: record.cacheReadTokens,
            costMicrodollars: record.costMicrodollars,
        })),
    });

    logger.info(`Persisted ${records.length} cost records to generation ${generation.id}`);
}
