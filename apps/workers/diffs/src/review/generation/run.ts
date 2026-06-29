import { db } from "@autonoma/db";
import { type Codebase, GenerationReviewer, StorageEvidenceLoader, openModelSession } from "@autonoma/diffs";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { GenerationVerdict } from "@autonoma/types";
import { DiffJobContextLoader } from "../diff-job-context-loader";
import { GenerationReviewPersister } from "./persister";

export interface RunGenerationReviewDeps {
    codebase: Codebase;
}

export interface RunGenerationReviewResult {
    /** "completed" if a verdict was persisted; "failed" if the agent didn't produce one; "skipped" if the review was already completed. */
    status: "completed" | "failed" | "skipped";
    /** The full verdict, when status is "completed". Consumers downstream (issue creator) take this directly. */
    verdict?: GenerationVerdict;
    reviewId?: string;
    organizationId?: string;
    finalScreenshotKey?: string;
    videoKey?: string;
}

/**
 * Production entry point: read the generation, create the review row if
 * missing, run the reviewer, persist the verdict.
 *
 * Local-CLI / read-only usage **does not go through this function**. It
 * composes the building blocks directly (`DiffJobContextLoader` +
 * `GenerationReviewer`) so the reviewer implementations stay free of
 * persistence-policy flags.
 */
export async function runGenerationReview(
    generationId: string,
    deps: RunGenerationReviewDeps,
): Promise<RunGenerationReviewResult> {
    logger.info("Starting generation review", { generationId });

    const generation = await db.testGeneration.findUniqueOrThrow({
        where: { id: generationId },
        select: {
            failure: true,
            organizationId: true,
            generationReview: { select: { id: true, status: true } },
        },
    });

    if (generation.failure?.kind === "scenario_setup") {
        logger.info("Generation failed during scenario setup - skipping review", { generationId });
        return { status: "skipped" };
    }

    if (generation.generationReview?.status === "completed") {
        logger.info("Skipping - completed review already exists", { generationId });
        return { status: "skipped" };
    }

    if (generation.generationReview == null) {
        await db.generationReview.create({
            data: { generationId, organizationId: generation.organizationId },
        });
    }

    const session = openModelSession();
    const videoModel = session.getVideoModel({ model: "smart-visual", tag: "generation-review" });

    const storage = S3Storage.createFromEnv();
    const contextLoader = new DiffJobContextLoader(db, storage);
    const context = await contextLoader.loadGeneration(generationId);

    const evidenceLoader = new StorageEvidenceLoader(storage);
    const reviewer = new GenerationReviewer({
        videoModel,
        evidenceLoader,
    });
    let verdict: GenerationVerdict | undefined;
    try {
        const runOutcome = await reviewer.run({ context, codebase: deps.codebase });
        verdict = runOutcome.result;
    } catch (err) {
        logger.warn("Generation review did not produce a verdict", {
            generationId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    const persister = new GenerationReviewPersister();

    if (verdict == null) {
        await persister.markFailed(generationId);
        return { status: "failed" };
    }

    const { reviewId } = await persister.persist({
        generationId,
        verdict,
        finalScreenshotKey: context.finalScreenshotKey,
        videoKey: context.videoUrl,
        costCollector: session.costCollector,
    });

    return {
        status: "completed",
        verdict,
        reviewId,
        organizationId: context.organizationId,
        finalScreenshotKey: context.finalScreenshotKey,
        videoKey: context.videoUrl,
    };
}
