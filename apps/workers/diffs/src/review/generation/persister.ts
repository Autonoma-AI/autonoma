import type { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { GenerationVerdict, SuspectedCause } from "@autonoma/types";

export interface PersistGenerationReviewParams {
    generationId: string;
    verdict: GenerationVerdict;
    finalScreenshotKey?: string;
    videoKey?: string;
    costCollector?: CostCollector;
}

/**
 * Persists a generation verdict and any AI cost records. **Does not** create
 * issues or bugs - that's IssueReporter's job (called separately by the
 * activity).
 */
export class GenerationReviewPersister {
    private readonly logger: Logger;

    constructor() {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async persist(params: PersistGenerationReviewParams): Promise<{ reviewId: string }> {
        const { generationId, verdict } = params;
        this.logger.info("Persisting generation review", { generationId, verdict: verdict.verdict });

        const enrichedEvidence = enrichEvidence(verdict.evidence, params);

        // `suspectedCause` rides in the analysis JSON (no dedicated column) and
        // is only present on `application_bug` verdicts.
        const analysis: {
            failurePoint: GenerationVerdict["failurePoint"];
            evidence: GenerationVerdict["evidence"];
            suspectedCause?: SuspectedCause;
        } = {
            failurePoint: verdict.failurePoint,
            evidence: enrichedEvidence,
        };
        if (verdict.verdict === "application_bug") analysis.suspectedCause = verdict.suspectedCause;

        const reviewId = await db.$transaction(async (tx) => {
            const review = await tx.generationReview.update({
                where: { generationId },
                data: {
                    status: "completed",
                    verdict: verdict.verdict,
                    reasoning: verdict.reasoning,
                    analysis,
                },
                select: { id: true },
            });

            const records = params.costCollector?.getRecords() ?? [];
            if (records.length > 0) {
                await tx.aiCostRecord.createMany({
                    data: records.map((record) => ({
                        generationId,
                        model: record.model,
                        tag: record.tag,
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

    async markFailed(generationId: string): Promise<void> {
        this.logger.warn("Marking generation review as failed (no verdict produced)", { generationId });
        await db.generationReview.update({
            where: { generationId },
            data: { status: "failed" },
        });
    }
}

function enrichEvidence(
    evidence: GenerationVerdict["evidence"],
    extras: { finalScreenshotKey?: string; videoKey?: string },
): GenerationVerdict["evidence"] {
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
