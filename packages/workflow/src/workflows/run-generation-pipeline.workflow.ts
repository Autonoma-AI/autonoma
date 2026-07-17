import { executeChild, proxyActivities } from "@temporalio/workflow";
import type { GeneralActivities, RunGenerationPipelineInput } from "../activities/general-activities";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "./workflow-types";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "1m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

/**
 * Runs the generation pipeline for everything currently pending in the snapshot:
 *
 *   1. Queue every pending gen (`prepareGenerationQueue`).
 *   2. Fire `batchGenerationWorkflow` and wait. After the batch returns, every
 *      generation row is in a terminal status and its review activity has run
 *      (single-generation's finally block awaits the review).
 *
 * A generation passing its review is the definition of "validated" - there is
 * no replay step. Reviews are awaited inside the gen finally block, so by the
 * time this workflow returns every generation row's review has a terminal
 * status and the next iteration's analyzeResults can safely read them.
 *
 * Pre: the set of pending gens in the snapshot at call time equals the scope
 * the current iteration owns. The refinement loop maintains this invariant.
 *
 * No return value - outcomes land in DB.
 */
export async function runGenerationPipelineWorkflow(input: RunGenerationPipelineInput): Promise<void> {
    const { generations } = await general.prepareGenerationQueue({
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    if (generations.length === 0) return;

    // Architecture is an application-level property; all plans in a refinement
    // loop belong to the same application, so all generations share an
    // architecture. If that invariant ever breaks, batchGenerationWorkflow's
    // single-architecture input shape would also need to change.
    await executeChild(WORKFLOW_TYPE.BATCH_GENERATION, {
        workflowId: `gen-pipeline-batch-${input.loopId}-iter-${input.iterationNumber}`,
        taskQueue: TaskQueue.GENERAL,
        args: [
            {
                testPlans: generations.map((g) => ({
                    testGenerationId: g.testGenerationId,
                    scenarioId: g.scenarioId,
                })),
                architecture: generations[0]!.architecture,
            },
        ],
    });
}
