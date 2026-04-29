import type { WorkflowArchitecture } from "../types";

export interface AnalyzeDiffsInput {
    snapshotId: string;
}

export interface TestCandidateInfo {
    name: string;
    instruction: string;
    url?: string;
    reasoning: string;
}

export type AffectedReason = "code_change" | "merge_plan_imported" | "merge_conflict";

export interface AffectedTestInfo {
    slug: string;
    testName: string;
    reasoning: string;
    affectedReason?: AffectedReason;
}

export interface PreparedRunInfo {
    runId: string;
    slug: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}

export interface AnalyzeDiffsOutput {
    preparedRuns: PreparedRunInfo[];
    testCandidates: TestCandidateInfo[];
    affectedTests: AffectedTestInfo[];
    reasoning: string;
}

export interface ResolveDiffsInput {
    snapshotId: string;
    runIds: string[];
    step1Reasoning: string;
    testCandidates: TestCandidateInfo[];
    affectedTests: AffectedTestInfo[];
}

export interface GenerationInfo {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

export interface ResolveDiffsOutput {
    generations: GenerationInfo[];
    modifiedTests: number;
    quarantinedTests: number;
    bugsTracked: number;
}

export interface FinalizeDiffsInput {
    snapshotId: string;
    generationIds: string[];
}

export interface DiffsActivities {
    analyzeDiffs(input: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput>;
    resolveDiffs(input: ResolveDiffsInput): Promise<ResolveDiffsOutput>;
    finalizeDiffs(input: FinalizeDiffsInput): Promise<void>;
}
