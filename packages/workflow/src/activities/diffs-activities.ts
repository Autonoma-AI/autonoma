import type {
    ReviewGenerationInput,
    ReviewGenerationOutput,
    RunHealingAgentForRefinementInput,
    RunHealingAgentForRefinementOutput,
} from "./general-activities";

export interface AnalyzeDiffsInput {
    snapshotId: string;
}

export interface MarkDiffsGeneratingInput {
    snapshotId: string;
}

export interface FinalizeDiffsInput {
    snapshotId: string;
    /** When provided, the DiffsJob is marked failed with this reason instead of completed. */
    failureReason?: string;
}

/**
 * Activities executed on the {@link TaskQueue.DIFFS} task queue. Lives on the
 * diffs worker so the heavy AI-powered review and healing work shares the
 * pool already provisioned for diffs.
 */
export interface DiffsActivities {
    analyzeDiffs(input: AnalyzeDiffsInput): Promise<void>;
    markDiffsGenerating(input: MarkDiffsGeneratingInput): Promise<void>;
    finalizeDiffs(input: FinalizeDiffsInput): Promise<void>;
    reviewGeneration(input: ReviewGenerationInput): Promise<ReviewGenerationOutput>;
    runHealingAgentForRefinement(input: RunHealingAgentForRefinementInput): Promise<RunHealingAgentForRefinementOutput>;
}
