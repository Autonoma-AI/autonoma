/**
 * Activities executed on the "mobile" task queue.
 * Workers must export an object that `satisfies MobileActivities` to ensure type safety.
 */

export interface RunMobileGenerationInput {
    testGenerationId: string;
}

export interface RunMobileReplayInput {
    runId: string;
}

export interface MobileActivities {
    runMobileGeneration(input: RunMobileGenerationInput): Promise<void>;
    runMobileReplay(input: RunMobileReplayInput): Promise<void>;
}
