import type { CostRecord } from "@autonoma/ai";
import type { PrismaClient } from "@autonoma/db";
import { getObservabilityContext, type Logger } from "@autonoma/logger";

/** Exactly one of these identifies which entity a batch of AI calls' cost belongs to. */
export interface AiCostAnchor {
    generationId?: string;
    runId?: string;
    investigationSnapshotId?: string;
}

/**
 * Persist a batch of metered AI-call cost records as `AiCostRecord` rows, stamped with the
 * caller's org - resolved from the ambient observability context (bound by the Temporal
 * activity interceptor whenever the activity's input carries a
 * `snapshotId`/`testGenerationId`/`generationId`), never passed as a parameter here. This is
 * what makes org attribution transparent to a new job: call this with a `CostCollector`'s
 * records and an anchor, and the org is stamped correctly with no org to resolve.
 *
 * Recording only - no credit deduction happens here. That's a deliberate follow-up once
 * pricing is decided; this only makes every `AiCostRecord` row explainable per org.
 */
export async function persistAiCosts(
    db: PrismaClient,
    records: readonly CostRecord[],
    anchor: AiCostAnchor,
    logger: Logger,
): Promise<void> {
    if (records.length === 0) return;

    const organizationId = getObservabilityContext().organization?.organizationId;
    if (organizationId == null) {
        logger.warn("No organizationId in observability context - skipping AI cost persistence", {
            extra: { anchor },
        });
        return;
    }

    await db.aiCostRecord.createMany({
        data: records.map((record) => ({
            ...anchor,
            organizationId,
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
    logger.info("Persisted AI costs", { extra: { count: records.length, costMicrodollars, anchor } });
}
