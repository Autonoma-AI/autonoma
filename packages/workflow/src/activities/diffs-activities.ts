import type { WorkflowArchitecture } from "../types";

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

export interface GenerationInfo {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

export interface ResolveDiffsOutput {
    generations: GenerationInfo[];
}

export interface FinalizeDiffsInput {
    snapshotId: string;
}

export interface DiffsActivities {
    analyzeDiffs(input: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput>;
    resolveDiffs(input: ResolveDiffsInput): Promise<ResolveDiffsOutput>;
    finalizeDiffs(input: FinalizeDiffsInput): Promise<void>;
}
