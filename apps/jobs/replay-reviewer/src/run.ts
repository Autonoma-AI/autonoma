import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { createReviewServices } from "./create-review-services";
import { RunDataLoader } from "./data-loader";
import { persistReplayReview } from "./persist-review-result";
import { ReplayReviewer } from "./replay-reviewer";

export async function runReplayReview(runId: string): Promise<void> {
    logger.info("Starting replay reviewer", { runId });

    const run = await db.run.findUniqueOrThrow({
        where: { id: runId },
        select: {
            status: true,
            assignment: {
                select: {
                    testCase: {
                        select: {
                            application: { select: { organizationId: true } },
                        },
                    },
                },
            },
            runReview: { select: { id: true, status: true } },
        },
    });

    if (run.status !== "failed") {
        logger.info("Run is not failed - skipping review", { runId, status: run.status });
        return;
    }

    const existingReview = run.runReview;
    if (existingReview != null && existingReview.status === "completed") {
        logger.info("A completed review already exists - skipping", { runId });
        return;
    }

    if (existingReview == null) {
        const organizationId = run.assignment.testCase.application.organizationId;
        logger.info("Creating run review record", { runId });
        await db.runReview.create({
            data: { runId, organizationId },
        });
    }

    const storage = S3Storage.createFromEnv();
    const dataLoader = new RunDataLoader(db, storage);
    const data = await dataLoader.loadRun(runId);

    const { costCollector, model, videoProcessor, bugLinker } = createReviewServices();

    const reviewer = new ReplayReviewer(model, dataLoader, videoProcessor);
    const result = await reviewer.review(data);

    const verdict = result.verdict;

    if (verdict == null) {
        logger.warn("Review did not produce a verdict - marking as failed", { runId: data.runId });
        await db.runReview.update({
            where: { runId: data.runId },
            data: { status: "failed" },
        });
        return;
    }

    logger.info("Persisting review result", { verdict: verdict.verdict });

    await persistReplayReview({
        runId: data.runId,
        organizationId: data.organizationId,
        finalScreenshotKey: data.finalScreenshotKey,
        videoS3Key: data.videoS3Key,
        verdict,
        costCollector,
        bugLinker,
    });

    logger.info("Replay review completed successfully", {
        verdict: verdict.verdict,
        runId: data.runId,
    });
}
