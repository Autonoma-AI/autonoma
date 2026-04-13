import type { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { BUG_CONFIDENCE_THRESHOLD, type BugLinker } from "@autonoma/review";
import type { ReviewVerdict } from "./review-result";

interface PersistGenerationReviewParams {
    generationId: string;
    organizationId: string;
    finalScreenshotKey?: string;
    videoUrl?: string;
    verdict: ReviewVerdict;
    costCollector: CostCollector;
    bugLinker: BugLinker;
}

export async function persistGenerationReview(params: PersistGenerationReviewParams): Promise<void> {
    const { generationId, organizationId, verdict, costCollector, bugLinker } = params;

    const enrichedEvidence = verdict.evidence.map((item) => {
        if (item.type === "screenshot" && params.finalScreenshotKey != null) {
            return { ...item, s3Key: params.finalScreenshotKey };
        }
        if (item.type === "video" && params.videoUrl != null) {
            return { ...item, s3Key: params.videoUrl };
        }
        return item;
    });

    await db.$transaction(async (tx) => {
        const review = await tx.generationReview.update({
            where: { generationId },
            data: {
                status: "completed",
                verdict: verdict.verdict,
                reasoning: verdict.reasoning,
                analysis: {
                    failurePoint: verdict.failurePoint,
                    evidence: enrichedEvidence,
                },
            },
        });

        const issue = await tx.issue.upsert({
            where: { generationReviewId: review.id },
            create: {
                generationReviewId: review.id,
                category: verdict.verdict,
                confidence: verdict.confidence,
                severity: verdict.severity,
                title: verdict.title,
                description: verdict.reasoning,
                organizationId,
            },
            update: {
                category: verdict.verdict,
                confidence: verdict.confidence,
                severity: verdict.severity,
                title: verdict.title,
                description: verdict.reasoning,
            },
        });

        if (verdict.verdict === "application_bug" && verdict.confidence >= BUG_CONFIDENCE_THRESHOLD) {
            const generation = await tx.testGeneration.findUniqueOrThrow({
                where: { id: generationId },
                select: {
                    snapshot: { select: { branchId: true } },
                    testPlan: { select: { testCaseId: true } },
                },
            });

            await bugLinker.linkIssueToBug(tx, {
                issueId: issue.id,
                issueTitle: verdict.title,
                issueDescription: verdict.reasoning,
                branchId: generation.snapshot.branchId,
                testCaseId: generation.testPlan.testCaseId,
                severity: verdict.severity,
                organizationId,
            });
        }

        const costRecords = costCollector.getRecords();
        if (costRecords.length > 0) {
            logger.info("Saving cost records", { count: costRecords.length });
            await tx.aiCostRecord.createMany({
                data: costRecords.map((record) => ({
                    generationId,
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
    });
}
