import type { WorkflowArchitecture } from "../types";
import type {
    ReviewGenerationInput,
    ReviewGenerationOutput,
    ReviewReplayInput,
    ReviewReplayOutput,
    RunHealingAgentForRefinementInput,
    RunHealingAgentForRefinementOutput,
} from "./general-activities";

export interface AnalyzeDiffsInput {
    snapshotId: string;
}

export interface PreparedRunInfo {
    runId: string;
    slug: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}

export interface AnalyzeDiffsOutput {
    replays: PreparedRunInfo[];
}

export interface ResolveDiffsInput {
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
 * pool already provisioned for diffs/resolution.
 */
export interface DiffsActivities {
    analyzeDiffs(input: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput>;
    resolveDiffs(input: ResolveDiffsInput): Promise<void>;
    finalizeDiffs(input: FinalizeDiffsInput): Promise<void>;
    reviewGeneration(input: ReviewGenerationInput): Promise<ReviewGenerationOutput>;
    reviewReplay(input: ReviewReplayInput): Promise<ReviewReplayOutput>;
    runHealingAgentForRefinement(input: RunHealingAgentForRefinementInput): Promise<RunHealingAgentForRefinementOutput>;
}
