import type {
    ReviewGenerationInput,
    ReviewGenerationOutput,
    RunHealingAgentForRefinementInput,
    RunHealingAgentForRefinementOutput,
} from "./general-activities";

export interface PrepareDiffsRunInput {
    organizationId: string;
    branchId: string;
    headSha: string;
    /** Fallback base sha (the PR base) used when the branch has no active-snapshot head yet. */
    baseSha: string;
    /** The preview origin the diffs run seeds and tests against. */
    url: string;
}

export type PrepareDiffsRunResult = { skipped: true } | { skipped: false; snapshotId: string };

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
    prepareDiffsRun(input: PrepareDiffsRunInput): Promise<PrepareDiffsRunResult>;
    analyzeDiffs(input: AnalyzeDiffsInput): Promise<void>;
    markDiffsGenerating(input: MarkDiffsGeneratingInput): Promise<void>;
    finalizeDiffs(input: FinalizeDiffsInput): Promise<void>;
    reviewGeneration(input: ReviewGenerationInput): Promise<ReviewGenerationOutput>;
    runHealingAgentForRefinement(input: RunHealingAgentForRefinementInput): Promise<RunHealingAgentForRefinementOutput>;
}
