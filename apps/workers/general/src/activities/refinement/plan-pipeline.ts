import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type {
    CreatedRun,
    PrepareGenerationQueueInput,
    PrepareGenerationQueueOutput,
    PrepareRunsForGenerationsInput,
    PrepareRunsForGenerationsOutput,
    WorkflowArchitecture,
} from "@autonoma/workflow/activities";

/**
 * Validates deployment, marks every pending generation in the snapshot as queued,
 * and returns the list ready for dispatch.
 *
 * Invariant this depends on: at call time, the snapshot's pending generations
 * are exactly the set of plans the current iteration owns. See the same
 * invariant note on `initRefinementLoop` in loop-lifecycle.ts - the refinement
 * loop maintains it via two arms:
 *
 *   - Iter 1: upstream's pre-loop activity queues exactly the plans needing
 *     refinement; `initRefinementLoop` reads them as iter 1's inputs.
 *   - Iter N+1: `applyHealingActions` calls `addJob` (via `TestSuiteChange.apply`)
 *     exactly for the planIds it records in `RefinementIterationInput` for
 *     iter N+1. Prior iter's gens are terminal (success/failed), not pending,
 *     so the new pending rows are exactly the planIds that need firing.
 *
 * If a future code path queues pending generations outside the refinement loop's
 * coordination, this activity will sweep them into the current iteration's
 * dispatch. New pending-gen-creator paths must coordinate with the loop or use
 * a different status to remain invisible here.
 */
export async function prepareGenerationQueue(
    input: PrepareGenerationQueueInput,
): Promise<PrepareGenerationQueueOutput> {
    const logger = rootLogger.child({ name: "prepareGenerationQueue" });
    logger.info("Preparing generation queue for snapshot");

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const prepared = await updater.prepareGenerationQueue();

    logger.info("Generation queue prepared", { extra: { count: prepared.length } });

    return {
        generations: prepared.map((p) => ({
            testGenerationId: p.testGenerationId,
            scenarioId: p.scenarioId,
            architecture: p.architecture as WorkflowArchitecture,
        })),
    };
}

/**
 * Given a set of completed generations, creates a Run for each that passed
 * gen-review. Failures are not returned - the next iteration's `analyzeResults`
 * reads them from DB via the RefinementIterationInput rows.
 *
 * Pre: every gen in `generationIds` has a terminal status (success/failed) and
 * its review has run. The pipeline workflow guarantees this by awaiting the
 * batch-generation child (whose finally block awaits the review activity).
 */
export async function prepareRunsForGenerations(
    input: PrepareRunsForGenerationsInput,
): Promise<PrepareRunsForGenerationsOutput> {
    const logger = rootLogger.child({ name: "prepareRunsForGenerations" });
    logger.info("Creating runs for successful generations", { extra: { count: input.generationIds.length } });

    if (input.generationIds.length === 0) return { runs: [] };

    const generations = await db.testGeneration.findMany({
        where: { id: { in: input.generationIds } },
        select: {
            id: true,
            status: true,
            organizationId: true,
            snapshotId: true,
            testPlan: {
                select: {
                    id: true,
                    scenarioId: true,
                    testCaseId: true,
                    testCase: {
                        select: { application: { select: { architecture: true } } },
                    },
                },
            },
            generationReview: { select: { verdict: true, status: true } },
        },
    });

    const successful = generations.filter(isGenerationSuccess);
    if (successful.length === 0) {
        logger.info("No successful generations; nothing to dispatch");
        return { runs: [] };
    }

    const assignments = await db.testCaseAssignment.findMany({
        where: {
            OR: successful.map((g) => ({
                snapshotId: g.snapshotId,
                testCaseId: g.testPlan.testCaseId,
            })),
        },
        select: { id: true, stepsId: true, snapshotId: true, testCaseId: true },
    });
    const assignmentByKey = new Map(assignments.map((a) => [`${a.snapshotId}:${a.testCaseId}`, a]));

    const runs: CreatedRun[] = [];
    for (const generation of successful) {
        const assignment = assignmentByKey.get(`${generation.snapshotId}:${generation.testPlan.testCaseId}`);
        if (assignment == null) throw new Error(`Assignment for generation ${generation.id} not found`);
        if (assignment.stepsId == null) {
            throw new Error(
                `Assignment for generation ${generation.id} has no stepsId; assignGenerationResults must run first`,
            );
        }

        const run = await db.run.create({
            data: {
                assignmentId: assignment.id,
                organizationId: generation.organizationId,
                planId: generation.testPlan.id,
            },
            select: { id: true },
        });

        runs.push({
            runId: run.id,
            architecture: generation.testPlan.testCase.application.architecture as WorkflowArchitecture,
            scenarioId: generation.testPlan.scenarioId ?? undefined,
        });
    }

    logger.info("Runs created", { extra: { count: runs.length } });
    return { runs };
}

type SuccessCheckRow = {
    status: string;
    generationReview: { verdict: string | null; status: string } | null;
};

function isGenerationSuccess(generation: SuccessCheckRow): boolean {
    const review = generation.generationReview;
    return generation.status === "success" && review?.status === "completed" && review.verdict === "success";
}
