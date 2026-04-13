import type {
    FiredBatch,
    GenerationJobOptions,
    GenerationProvider,
    PendingGeneration,
} from "./generation-job-provider";

export class FakeGenerationProvider implements GenerationProvider {
    public readonly firedBatches: PendingGeneration[][] = [];

    async fireJobs(generations: PendingGeneration[], _options?: GenerationJobOptions): Promise<FiredBatch> {
        this.firedBatches.push(generations);

        return { batchWorkflowId: "", batchWorkflowRunId: "" };
    }
}
