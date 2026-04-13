import type { WorkflowArchitecture } from "@autonoma/workflow";

export interface PendingGeneration {
    testGenerationId: string;
    planId: string;
    scenarioId: string | undefined;
    architecture: WorkflowArchitecture;
}

export interface GenerationJobOptions {
    autoActivate?: boolean;
}

export interface FiredBatch {
    /** Batch workflow ID - usable as a fallback link before child workflows are created. */
    batchWorkflowId: string;
    batchWorkflowRunId: string;
}

export interface GenerationProvider {
    fireJobs(generations: PendingGeneration[], options?: GenerationJobOptions): Promise<FiredBatch>;
}
