import type { WorkflowArchitecture } from "@autonoma/workflow";

/** One started run, as far as dispatching it to the worker fleet is concerned. */
export interface PendingGeneration {
    testGenerationId: string;
    scenarioId: string | undefined;
    architecture: WorkflowArchitecture;
}

export interface FiredBatch {
    /** Batch workflow ID - usable as a fallback link before child workflows are created. */
    batchWorkflowId: string;
    batchWorkflowRunId: string;
}

export interface GenerationProvider {
    fireJobs(snapshotId: string, generations: PendingGeneration[]): Promise<FiredBatch>;
}
