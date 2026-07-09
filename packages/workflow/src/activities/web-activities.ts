/**
 * Activities executed on the "web" task queue.
 * Workers must export an object that `satisfies WebActivities` to ensure type safety.
 */

export interface RunWebGenerationInput {
    testGenerationId: string;
    urlOverride?: string;
    sdkUrlOverride?: string;
}

export interface WebActivities {
    runWebGeneration(input: RunWebGenerationInput): Promise<void>;
}
