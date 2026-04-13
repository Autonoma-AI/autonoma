import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import { createReviewServices } from "./create-review-services";
import { GenerationDataLoader } from "./data-loader";
import { GenerationReviewer } from "./generation-reviewer";
import { persistGenerationReview } from "./persist-review-result";

export async function runGenerationReview(generationId: string): Promise<void> {
    logger.info("Starting generation reviewer", { generationId });

    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: {
            status: true,
            organizationId: true,
            generationReview: { select: { id: true, status: true } },
        },
    });

    if (generation.status !== "failed") {
        logger.info("Generation is not failed - skipping review", { generationId, status: generation.status });
        return;
    }

    const existingReview = generation.generationReview;
    if (existingReview != null && existingReview.status === "completed") {
        logger.info("A completed review already exists - skipping", { generationId });
        return;
    }

    if (existingReview == null) {
        logger.info("Creating generation review record", { generationId });
        await db.generationReview.create({
            data: { generationId, organizationId: generation.organizationId },
        });
    }

    const storage = S3Storage.createFromEnv();
    const dataLoader = new GenerationDataLoader(db, storage);
    const data = await dataLoader.loadGeneration(generationId);

    const { costCollector, model, videoProcessor, bugLinker } = createReviewServices();

    const reviewer = new GenerationReviewer(model, dataLoader, videoProcessor);
    const result = await reviewer.review(data);

    const verdict = result.verdict;

    if (verdict == null) {
        logger.warn("Review did not produce a verdict - marking as failed", { generationId: data.generationId });
        await db.generationReview.update({
            where: { generationId: data.generationId },
            data: { status: "failed" },
        });
        return;
    }

    logger.info("Persisting review result", { verdict: verdict.verdict });

    await persistGenerationReview({
        generationId: data.generationId,
        organizationId: data.organizationId,
        finalScreenshotKey: data.finalScreenshotKey,
        videoUrl: data.videoUrl,
        verdict,
        costCollector,
        bugLinker,
    });

    logger.info("Generation review completed successfully", {
        verdict: verdict.verdict,
        generationId: data.generationId,
    });
}
