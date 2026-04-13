import type { CostCollector } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { BUG_CONFIDENCE_THRESHOLD, type BugLinker } from "@autonoma/review";
import type { ReviewVerdict } from "@autonoma/types";

interface PersistReplayReviewParams {
    runId: string;
    organizationId: string;
    finalScreenshotKey?: string;
    videoS3Key?: string;
    verdict: ReviewVerdict;
    costCollector: CostCollector;
    bugLinker: BugLinker;
}

export async function persistReplayReview(params: PersistReplayReviewParams): Promise<void> {
    const { runId, organizationId, verdict, costCollector, bugLinker } = params;

    const enrichedEvidence = verdict.evidence.map((item) => {
        if (item.type === "screenshot" && params.finalScreenshotKey != null) {
            return { ...item, s3Key: params.finalScreenshotKey };
        }
        if (item.type === "video" && params.videoS3Key != null) {
            return { ...item, s3Key: params.videoS3Key };
        }
        return item;
    });

    await db.$transaction(async (tx) => {
        const review = await tx.runReview.update({
            where: { runId },
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
            where: { runReviewId: review.id },
            create: {
                runReviewId: review.id,
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
            const run = await tx.run.findUniqueOrThrow({
                where: { id: runId },
                select: {
                    assignment: {
                        select: {
                            testCaseId: true,
                            snapshot: { select: { branchId: true } },
                        },
                    },
                },
            });

            await bugLinker.linkIssueToBug(tx, {
                issueId: issue.id,
                issueTitle: verdict.title,
                issueDescription: verdict.reasoning,
                branchId: run.assignment.snapshot.branchId,
                testCaseId: run.assignment.testCaseId,
                severity: verdict.severity,
                organizationId,
            });
        }

        const costRecords = costCollector.getRecords();
        if (costRecords.length > 0) {
            logger.info("Saving cost records", { count: costRecords.length });
            await tx.aiCostRecord.createMany({
                data: costRecords.map((record) => ({
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
    });
}
