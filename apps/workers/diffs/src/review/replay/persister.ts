import type { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { ReplayVerdict } from "@autonoma/types";

export interface PersistRunReviewParams {
    runId: string;
    verdict: ReplayVerdict;
    finalScreenshotKey?: string;
    videoKey?: string;
    costCollector?: CostCollector;
}

export class RunReviewPersister {
    private readonly logger: Logger;

    constructor() {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async persist(params: PersistRunReviewParams): Promise<{ reviewId: string }> {
        const { runId, verdict } = params;
        this.logger.info("Persisting run review", { runId, verdict: verdict.verdict });

        const enrichedEvidence = enrichEvidence(verdict.evidence, params);

        const reviewId = await db.$transaction(async (tx) => {
            const review = await tx.runReview.update({
                where: { runId },
                data: {
                    status: "completed",
                    verdict: verdict.verdict,
                    reasoning: verdict.reasoning,
                    analysis: { failurePoint: verdict.failurePoint, evidence: enrichedEvidence },
                },
                select: { id: true },
            });

            const records = params.costCollector?.getRecords() ?? [];
            if (records.length > 0) {
                await tx.aiCostRecord.createMany({
                    data: records.map((record) => ({
                        runId,
                        model: record.model,
                        tag: `review/${record.tag}`,
                        inputTokens: record.inputTokens,
                        outputTokens: record.outputTokens,
                        reasoningTokens: record.reasoningTokens,
                        cacheReadTokens: record.cacheReadTokens,
                        costMicrodollars: record.costMicrodollars,
                    })),
                });
            }

            return review.id;
        });

        return { reviewId };
    }

    async markFailed(runId: string): Promise<void> {
        this.logger.warn("Marking run review as failed (no verdict produced)", { runId });
        await db.runReview.update({
            where: { runId },
            data: { status: "failed" },
        });
    }
}

function enrichEvidence(
    evidence: ReplayVerdict["evidence"],
    extras: { finalScreenshotKey?: string; videoKey?: string },
): ReplayVerdict["evidence"] {
    return evidence.map((item) => {
        if (item.type === "screenshot" && extras.finalScreenshotKey != null) {
            return { ...item, s3Key: extras.finalScreenshotKey };
        }
        if (item.type === "video" && extras.videoKey != null) {
            return { ...item, s3Key: extras.videoKey };
        }
        return item;
    });
}
