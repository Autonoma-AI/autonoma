/**
 * Activities executed on the "general" task queue.
 * Workers must export an object that `satisfies GeneralActivities` to ensure type safety.
 */

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

export interface MarkGenerationFailedInput {
    testGenerationId: string;
    reason?: string;
}

export interface MarkRunFailedInput {
    runId: string;
    reason?: string;
}

export interface GeneralActivities {
    scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput>;
    scenarioDown(input: ScenarioDownInput): Promise<void>;
    reviewGeneration(input: ReviewGenerationInput): Promise<void>;
    reviewReplay(input: ReviewReplayInput): Promise<void>;
    assignGenerationResults(input: AssignGenerationResultsInput): Promise<void>;
    markGenerationFailed(input: MarkGenerationFailedInput): Promise<void>;
    markRunFailed(input: MarkRunFailedInput): Promise<void>;
    notifyGenerationExit(input: NotifyGenerationExitInput): Promise<void>;
}
