import { CancellationScope, executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities/diffs-activities";
import type { GeneralActivities } from "../activities/general-activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "./workflow-types";

const general = proxyActivities<GeneralActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "1m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

const diffs = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface RefinementLoopInput {
    snapshotId: string;
    triggeredBy: "onboarding" | "diffs";
    maxIterations?: number;
}

export interface RefinementLoopResult {
    loopId: string;
    status: "converged" | "max_iterations" | "error";
    iterations: number;
    validatedTestCaseIds: string[];
}

const DEFAULT_MAX_ITERATIONS = 3;

/**
 * Refinement loop.
 *
 * Each iteration has the same shape: analyze results that already exist, heal
 * if any failed, then (if healing produced plan changes) fire the next
 * iteration's gen-replay pipeline. Iter 1's analyzable data is fired by the
 * init phase below; subsequent iterations have their data fired by the
 * previous iteration's tail. "Iter 1 is special" disappears from the body.
 *
 * The loop's scope - which plans each iteration is responsible for - is
 * recorded in `RefinementIterationInput` rows. Iter 1's rows come from the
 * snapshot's pending generations at init time (= upstream's "work the loop
 * must finish"); iter N+1's rows come from the planIds that healing's
 * update_plan / add_test actions produced. `analyzeResults` reads that table
 * directly; the loop has no implicit reads of upstream state.
 */
export async function refinementLoopWorkflow(input: RefinementLoopInput): Promise<RefinementLoopResult> {
    const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const baseIds = { snapshot: { snapshotId: input.snapshotId } };

    log.info("Refinement loop workflow started", {
        ...baseIds,
        extra: { maxIterations, triggeredBy: input.triggeredBy },
    });

    const { loopId, organizationId, firstIterationId, hasPendingWork } = await general.initRefinementLoop({
        snapshotId: input.snapshotId,
        triggeredBy: input.triggeredBy,
    });

    const loopIds = {
        ...baseIds,
        organization: { organizationId },
        refinementLoop: { loopId, triggeredBy: input.triggeredBy },
    };
    log.info("Refinement loop initialized", {
        ...loopIds,
        refinementIteration: { iterationId: firstIterationId, iterationNumber: 1 },
        extra: { hasPendingWork },
    });

    // --- Iteration loop: analyze, heal, fire next ---
    const validatedTestCaseIds = new Set<string>();
    let finalStatus: "converged" | "max_iterations" | "error" = "max_iterations";
    let iterationsRun = 0;
    let currentIterationId = firstIterationId;
    let currentIterationNumber = 1;

    try {
        if (hasPendingWork) {
            log.info("Firing iteration 1 generation pipeline", {
                ...loopIds,
                refinementIteration: { iterationId: firstIterationId, iterationNumber: 1 },
            });
            await executeChild(WORKFLOW_TYPE.RUN_GENERATION_PIPELINE, {
                workflowId: `gen-pipeline-${loopId}-iter-1`,
                taskQueue: TaskQueue.GENERAL,
                args: [
                    {
                        snapshotId: input.snapshotId,
                        organizationId,
                        loopId,
                        iterationNumber: 1,
                    },
                ],
            });
        }

        while (currentIterationNumber <= maxIterations) {
            iterationsRun = currentIterationNumber;
            const iterIds = {
                ...loopIds,
                refinementIteration: { iterationId: currentIterationId, iterationNumber: currentIterationNumber },
            };

            log.info("Refinement iteration starting", iterIds);
            await general.markRefinementIterationRunning({ iterationId: currentIterationId });

            const results = await general.analyzeResults({ iterationId: currentIterationId });
            for (const tcId of results.validatedTestCaseIds) validatedTestCaseIds.add(tcId);

            const hasFailures = results.failuresAtGeneration.length > 0 || results.failuresAtReplay.length > 0;
            log.info("Iteration analysis complete", {
                ...iterIds,
                extra: {
                    hasFailures,
                    validatedTestCaseCount: results.validatedTestCaseIds.length,
                    generationFailureCount: results.failuresAtGeneration.length,
                    replayFailureCount: results.failuresAtReplay.length,
                },
            });

            if (!hasFailures) {
                finalStatus = "converged";
                await general.finishRefinementIteration({ iterationId: currentIterationId });
                log.info("Refinement iteration converged with no failures", iterIds);
                break;
            }

            log.info("Running healing agent for iteration failures", iterIds);
            const triage = await diffs.runHealingAgentForRefinement({
                iterationId: currentIterationId,
                iteration: currentIterationNumber,
                snapshotId: input.snapshotId,
                organizationId,
                failuresAtGeneration: results.failuresAtGeneration,
                failuresAtReplay: results.failuresAtReplay,
            });

            const applyResult = await general.applyHealingActions({
                snapshotId: input.snapshotId,
                organizationId,
                actions: triage.persistedActions,
                currentIterationId,
                currentIterationNumber,
            });

            await general.finishRefinementIteration({ iterationId: currentIterationId });

            if (applyResult.nextIterationId == null) {
                finalStatus = "converged";
                log.info("Healing produced no plan changes; refinement converged", iterIds);
                break;
            }

            log.info("Firing next iteration generation pipeline", {
                ...iterIds,
                extra: { nextIterationNumber: currentIterationNumber + 1 },
            });
            await executeChild(WORKFLOW_TYPE.RUN_GENERATION_PIPELINE, {
                workflowId: `gen-pipeline-${loopId}-iter-${currentIterationNumber + 1}`,
                taskQueue: TaskQueue.GENERAL,
                args: [
                    {
                        snapshotId: input.snapshotId,
                        organizationId,
                        loopId,
                        iterationNumber: currentIterationNumber + 1,
                    },
                ],
            });

            currentIterationId = applyResult.nextIterationId;
            currentIterationNumber += 1;
        }

        await general.finishRefinementLoop({ loopId, status: finalStatus });
        log.info("Refinement loop finished", { ...loopIds, extra: { finalStatus, iterationsRun } });
    } catch (e) {
        log.error("Refinement loop failed", {
            ...loopIds,
            extra: { reason: rootFailureMessage(e) },
        });
        await CancellationScope.nonCancellable(async () => {
            try {
                await general.finishErroredRefinementIterations({ loopId });
            } catch (cleanupError) {
                log.error("Failed to close errored refinement iterations", {
                    ...loopIds,
                    extra: { reason: rootFailureMessage(cleanupError) },
                });
            }
            try {
                await general.finishRefinementLoop({ loopId, status: "error" });
            } catch (cleanupError) {
                log.error("Failed to mark refinement loop as errored", {
                    ...loopIds,
                    extra: { reason: rootFailureMessage(cleanupError) },
                });
            }
        });
        throw e;
    }

    await general.finalizePendingSnapshot({ snapshotId: input.snapshotId });
    log.info("Snapshot finalized after refinement loop", loopIds);

    return {
        loopId,
        status: finalStatus,
        iterations: iterationsRun,
        validatedTestCaseIds: [...validatedTestCaseIds],
    };
}
