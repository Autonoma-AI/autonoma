import type { LanguageModel, VideoProcessor } from "@autonoma/ai";
import { CostCollector, MODEL_ENTRIES, ModelRegistry } from "@autonoma/ai";
import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { S3Storage } from "@autonoma/storage";
import type { GenerationVerdict } from "@autonoma/types";
import { GenerationReviewer } from "../../agents/reviewers/generation/generation-reviewer";
import type { Codebase } from "../../codebase";
import { GenerationContextLoader } from "./context-loader";
import { GenerationReviewPersister } from "./persister";

export interface RunGenerationReviewDeps {
    codebase: Codebase;
    /** Optional pre-built model to reuse cost collector / monitoring callbacks. */
    model?: LanguageModel;
    /** Cost collector tied to `model`. Pass when `model` is provided. */
    costCollector?: CostCollector;
    videoProcessor?: VideoProcessor;
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
 * composes the building blocks directly (`GenerationContextLoader` +
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
            organizationId: true,
            generationReview: { select: { id: true, status: true } },
        },
    });

    if (generation.generationReview?.status === "completed") {
        logger.info("Skipping - completed review already exists", { generationId });
        return { status: "skipped" };
    }

    if (generation.generationReview == null) {
        await db.generationReview.create({
            data: { generationId, organizationId: generation.organizationId },
        });
    }

    const { model, costCollector, videoProcessor } = resolveAiDeps(deps);

    const storage = S3Storage.createFromEnv();
    const contextLoader = new GenerationContextLoader(db, storage);
    const context = await contextLoader.load(generationId);

    const reviewer = new GenerationReviewer({
        model,
        evidenceLoader: contextLoader,
        videoProcessor,
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
        costCollector,
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

function resolveAiDeps(deps: RunGenerationReviewDeps): {
    model: LanguageModel;
    costCollector: CostCollector;
    videoProcessor?: VideoProcessor;
} {
    if (deps.model != null && deps.costCollector != null) {
        return { model: deps.model, costCollector: deps.costCollector, videoProcessor: deps.videoProcessor };
    }

    const costCollector = deps.costCollector ?? new CostCollector();
    const registry = new ModelRegistry({
        models: { GEMINI_3_FLASH_PREVIEW: MODEL_ENTRIES.GEMINI_3_FLASH_PREVIEW },
        monitoring: costCollector.createMonitoringCallbacks(),
    });
    const model = registry.getModel({ model: "GEMINI_3_FLASH_PREVIEW", tag: "analysis" });
    return { model, costCollector, videoProcessor: deps.videoProcessor };
}
