import type { GenerationVerdict } from "@autonoma/types";

export interface ReviewGenerationInput {
    generationId: string;
}

export interface ReviewGenerationOutput {
    status: "completed" | "failed" | "skipped";
    verdict?: GenerationVerdict;
}

/**
 * Activities executed on the {@link TaskQueue.DIFFS} task queue. Lives on the
 * diffs worker so the heavy AI-powered review work shares the pool already
 * provisioned for diffs.
 */
export interface DiffsActivities {
    reviewGeneration(input: ReviewGenerationInput): Promise<ReviewGenerationOutput>;
}
