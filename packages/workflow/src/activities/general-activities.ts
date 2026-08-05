/**
 * Activities executed on the "general" task queue.
 * Workers must export an object that `satisfies GeneralActivities` to ensure type safety.
 */

export interface ScenarioUpInput {
    entityId: string;
    scenarioId: string;
    sdkUrlOverride?: string;
}

export interface ScenarioUpOutput {
    scenarioInstanceId: string;
}

export interface ScenarioDownInput {
    scenarioInstanceId: string;
}

export interface NotifyGenerationExitInput {
    testGenerationId: string;
}

export interface MarkGenerationFailedInput {
    testGenerationId: string;
    /** Structured reason the generation failed; persisted to the `failure` column. */
    failure: PrismaJson.GenerationFailure;
}

export interface GeneralActivities {
    scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput>;
    scenarioDown(input: ScenarioDownInput): Promise<void>;
    markGenerationFailed(input: MarkGenerationFailedInput): Promise<void>;
    notifyGenerationExit(input: NotifyGenerationExitInput): Promise<void>;
}
