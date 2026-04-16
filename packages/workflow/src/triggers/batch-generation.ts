import { createHash } from "node:crypto";
import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import type { TestPlanItem, WorkflowArchitecture, WorkflowRef } from "../types";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerBatchGenerationParams {
    testPlans: TestPlanItem[];
    architecture: WorkflowArchitecture;
    autoActivate?: boolean;
}

export async function triggerBatchGeneration(params: TriggerBatchGenerationParams): Promise<WorkflowRef> {
    const { testPlans, architecture, autoActivate } = params;
    const testGenerationIds = testPlans.map((tp) => tp.testGenerationId);

    logger.info("Triggering batch generation workflow", { testGenerationIds, architecture });

    const client = await getTemporalClient();
    const batchKey = createHash("sha256").update(testGenerationIds.join(":"), "utf8").digest("hex").slice(0, 16);
    const workflowId = `batch-generation-${batchKey}`;

    let handle;
    try {
        handle = await client.workflow.start(WORKFLOW_TYPE.BATCH_GENERATION, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.GENERAL,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [
                {
                    testPlans,
                    architecture,
                    autoActivate: autoActivate ?? false,
                },
            ],
        });
    } catch (error) {
        const grpcCause =
            error instanceof Error ? (error.cause as { code?: number; details?: string } | undefined) : undefined;
        logger.error("Failed to start batch generation workflow", error, {
            workflowId,
            testGenerationIds,
            errorMessage: error instanceof Error ? error.message : String(error),
            grpcCode: grpcCause?.code,
            grpcDetails: grpcCause?.details,
        });
        throw error;
    }

    logger.info("Batch generation workflow started", { workflowId, testGenerationIds });

    return { workflowId: handle.workflowId, runId: handle.firstExecutionRunId };
}

export async function findLatestWorkflowByGenerationId(
    generationId: string,
    fallbackBatchWorkflowId?: string,
): Promise<WorkflowRef | undefined> {
    const client = await getTemporalClient();

    // Try the child workflow first - it exists once the batch workflow starts executing
    try {
        const description = await client.workflow.getHandle(`generation-${generationId}`).describe();
        return { workflowId: description.workflowId, runId: description.runId };
    } catch {
        // Child not created yet (batch workflow pending)
    }

    // Fall back to the batch workflow if provided - useful while the workflow is queued
    // and no workers have picked it up yet
    if (fallbackBatchWorkflowId != null) {
        try {
            const description = await client.workflow.getHandle(fallbackBatchWorkflowId).describe();
            return { workflowId: description.workflowId, runId: description.runId };
        } catch (error) {
            logger.warn("Failed to query batch workflow", { generationId, fallbackBatchWorkflowId, error });
        }
    }

    return undefined;
}
