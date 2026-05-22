import { executeChild, log, ParentClosePolicy, proxyActivities } from "@temporalio/workflow";
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
 * Runs the gen-then-replay pipeline for everything currently pending in the
 * snapshot:
 *
 *   1. Queue every pending gen (`prepareGenerationQueue`).
 *   2. Fire `batchGenerationWorkflow` and wait. After the batch returns, every
 *      generation row is in a terminal status and its review activity has run
 *      (single-generation's finally block awaits the review).
 *   3. Create Run records for the gens that passed gen-review
 *      (`prepareRunsForGenerations`).
 *   4. Fire `runReplayWorkflow` per Run in parallel and wait. After each
 *      replay returns, its review activity has run too.
 *
 * Reviews are awaited inside the gen/replay finally blocks, so by the time
 * this workflow returns every gen/run row's review row has a terminal status.
 * The next iteration's analyzeResults can safely read them.
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
                snapshotId: input.snapshotId,
                testPlans: generations.map((g) => ({
                    testGenerationId: g.testGenerationId,
                    scenarioId: g.scenarioId,
                })),
                architecture: generations[0]!.architecture,
            },
        ],
    });

    const { runs } = await general.prepareRunsForGenerations({
        generationIds: generations.map((g) => g.testGenerationId),
    });

    if (runs.length === 0) return;

    const results = await Promise.allSettled(
        runs.map((run) =>
            executeChild(WORKFLOW_TYPE.RUN_REPLAY, {
                workflowId: `run-replay-${run.runId}`,
                taskQueue: TaskQueue.GENERAL,
                parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
                args: [{ runId: run.runId, architecture: run.architecture, scenarioId: run.scenarioId }],
            }),
        ),
    );

    for (const [index, result] of results.entries()) {
        if (result.status === "rejected") {
            log.warn("Child run-replay workflow failed", {
                runId: runs[index]!.runId,
                reason: String(result.reason),
            });
        }
    }
}
