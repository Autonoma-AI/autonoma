/**
 * Activities executed on the "general" task queue.
 * Workers must export an object that `satisfies GeneralActivities` to ensure type safety.
 */

import type { WorkflowArchitecture } from "../types";

export interface ScenarioUpInput {
    scenarioJobType: string;
    entityId: string;
    scenarioId: string;
}

export interface ScenarioUpOutput {
    scenarioInstanceId: string;
}

export interface ScenarioDownInput {
    scenarioInstanceId: string;
}

export interface ReviewGenerationInput {
    generationId: string;
    skipIssueBugCreation?: boolean;
}

export interface ReviewReplayInput {
    runId: string;
    skipIssueBugCreation?: boolean;
}

export interface AssignGenerationResultsInput {
    generationIds: string[];
    autoActivate: boolean;
}

export interface NotifyGenerationExitInput {
    testGenerationId: string;
}

export interface AnalyzeDiffsInput {
    snapshotId: string;
}

export interface TestCandidateInfo {
    name: string;
    instruction: string;
    url?: string;
    reasoning: string;
}

export type AffectedReason = "code_change";

export interface AffectedTestInfo {
    slug: string;
    testName: string;
    reasoning: string;
    affectedReason?: AffectedReason;
}

export interface AnalyzeDiffsOutput {
    preparedRuns: PreparedRunInfo[];
    testCandidates: TestCandidateInfo[];
    affectedTests: AffectedTestInfo[];
    reasoning: string;
}

export interface PreparedRunInfo {
    runId: string;
    slug: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}

export interface ResolveDiffsInput {
    snapshotId: string;
    runIds: string[];
    step1Reasoning: string;
    testCandidates: TestCandidateInfo[];
    affectedTests: AffectedTestInfo[];
}

export interface ResolveDiffsOutput {
    generations: GenerationInfo[];
    modifiedTests: number;
    quarantinedTests: number;
    bugsTracked: number;
}

export interface GenerationInfo {
    testGenerationId: string;
    scenarioId?: string;
    architecture: WorkflowArchitecture;
}

export interface FinalizeDiffsInput {
    snapshotId: string;
    generationIds: string[];
}

export interface MarkGenerationFailedInput {
    testGenerationId: string;
    reason?: string;
}

export interface GeneralActivities {
    scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput>;
    scenarioDown(input: ScenarioDownInput): Promise<void>;
    reviewGeneration(input: ReviewGenerationInput): Promise<void>;
    reviewReplay(input: ReviewReplayInput): Promise<void>;
    assignGenerationResults(input: AssignGenerationResultsInput): Promise<void>;
    markGenerationFailed(input: MarkGenerationFailedInput): Promise<void>;
    notifyGenerationExit(input: NotifyGenerationExitInput): Promise<void>;
    analyzeDiffs(input: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput>;
    resolveDiffs(input: ResolveDiffsInput): Promise<ResolveDiffsOutput>;
    finalizeDiffs(input: FinalizeDiffsInput): Promise<void>;
}
