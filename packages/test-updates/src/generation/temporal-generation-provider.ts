import { type Logger, logger } from "@autonoma/logger";
import { triggerBatchGeneration } from "@autonoma/workflow";
import type {
    FiredBatch,
    GenerationJobOptions,
    GenerationProvider,
    PendingGeneration,
} from "./generation-job-provider";

export class TemporalGenerationProvider implements GenerationProvider {
    private readonly logger: Logger;

    constructor() {
        this.logger = logger.child({ name: this.constructor.name });
    }

    async fireJobs(generations: PendingGeneration[], options?: GenerationJobOptions): Promise<FiredBatch> {
        const firstGeneration = generations[0];
        if (firstGeneration == null) {
            return { batchWorkflowId: "", batchWorkflowRunId: "" };
        }

        const architecture = firstGeneration.architecture;
        const testGenerationIds = generations.map((g) => g.testGenerationId);
        this.logger.info("Firing batch generation workflow", {
            testGenerationIds,
            architecture,
            autoActivate: options?.autoActivate,
        });

        const triggerResult = (await triggerBatchGeneration({
            testPlans: generations.map((g) => ({
                testGenerationId: g.testGenerationId,
                scenarioId: g.scenarioId,
            })),
            architecture,
            autoActivate: options?.autoActivate,
        })) as { workflowId?: string; runId?: string } | void;

        const workflowId = typeof triggerResult?.workflowId === "string" ? triggerResult.workflowId : "";
        const runId = typeof triggerResult?.runId === "string" ? triggerResult.runId : "";

        this.logger.info("Batch generation workflow fired", { testGenerationIds, workflowId });

        return { batchWorkflowId: workflowId, batchWorkflowRunId: runId };
    }
}
