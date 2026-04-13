/**
 * Activities executed on the "web" task queue.
 * Workers must export an object that `satisfies WebActivities` to ensure type safety.
 */

export interface RunWebGenerationInput {
    testGenerationId: string;
}

export interface RunWebReplayInput {
    runId: string;
}

export interface WebActivities {
    runWebGeneration(input: RunWebGenerationInput): Promise<void>;
    runWebReplay(input: RunWebReplayInput): Promise<void>;
}
