import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type {
    FinishRefinementIterationInput,
    FinishRefinementLoopInput,
    InitRefinementLoopInput,
    InitRefinementLoopOutput,
    MarkRefinementIterationRunningInput,
} from "@autonoma/workflow/activities";

/**
 * Bootstraps a refinement loop. In one transaction:
 *
 *   - Resolves orgId / appId from the snapshot.
 *   - Creates the RefinementLoop row (status=running).
 *   - Creates iteration 1 (status=pending).
 *   - Reads the snapshot's pending generations (= the seed of "work the loop
 *     must finish before activating the snapshot") and writes one
 *     RefinementIterationInput row per planId.
 *
 * `hasPendingWork` lets the workflow skip the iter-1 pipeline child entirely
 * when there's nothing to refine.
 *
 * Invariant this depends on: at trigger time, the snapshot's pending
 * generations are exactly the set of plans that need refinement. Maintained by
 * the upstream flows that trigger the loop:
 *
 *   - Diffs: `resolveDiffs` queues a pending gen via `addJob` for every plan
 *     it modifies (`UpdateTest`) or adds (`AddTest`). Affected tests with
 *     unchanged plans are handled separately by the resolution agent and don't
 *     get a pending gen - they stay out of the loop's scope.
 *   - Onboarding: `AddTest` changes during snapshot setup queue pending gens
 *     for every test the loop should validate.
 *   - `addJob`'s per-test-case dedup logic prevents stale pending rows from
 *     accumulating.
 *
 * If a future code path creates pending generations on the snapshot outside
 * these flows (e.g. a retry mechanism, a manual user-triggered regeneration,
 * a concurrent diffs trigger), this invariant breaks and the loop will sweep
 * those plans into its scope. Anything new that queues pending gens needs to
 * either coordinate with the loop's lifecycle or use a different status enum
 * value to remain invisible.
 */
export async function initRefinementLoop(input: InitRefinementLoopInput): Promise<InitRefinementLoopOutput> {
    const logger = rootLogger.child({ name: "initRefinementLoop" });
    logger.info("Initializing refinement loop", { triggeredBy: input.triggeredBy });

    // Snapshot-level metadata (org, branch) is immutable for a snapshot's lifetime;
    // resolving it via TestSuiteUpdater (out of transaction) avoids re-doing the
    // snapshot -> branch -> organization join we'd otherwise inline here.
    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
    });

    return await db.$transaction(async (tx) => {
        const pending = await tx.testGeneration.findMany({
            where: { snapshotId: input.snapshotId, status: "pending" },
            select: { testPlanId: true },
        });

        // Assert addJob's per-test-case invariant: at most one pending generation
        // per testPlan in a snapshot. If this fires, something has queued
        // generations outside the documented flows (see the function-level
        // comment) and the loop's "pending = my scope" semantics no longer hold.
        const planIds = pending.map((g) => g.testPlanId);
        const seenPlanIds = new Set<string>();
        const duplicatePlanIds = new Set<string>();
        for (const planId of planIds) {
            if (seenPlanIds.has(planId)) duplicatePlanIds.add(planId);
            else seenPlanIds.add(planId);
        }
        if (duplicatePlanIds.size > 0) {
            throw new Error(
                `Multiple pending generations exist for the same plan(s) in snapshot ${input.snapshotId}: ` +
                    `${[...duplicatePlanIds].join(", ")}. addJob's per-test-case dedup should make this impossible; ` +
                    `investigate which path is queueing generations outside the expected flows.`,
            );
        }

        const loop = await tx.refinementLoop.create({
            data: {
                snapshotId: input.snapshotId,
                organizationId: updater.organizationId,
                triggeredBy: input.triggeredBy,
                status: "running",
            },
            select: { id: true },
        });

        const iteration = await tx.refinementIteration.create({
            data: { loopId: loop.id, number: 1, status: "pending" },
            select: { id: true },
        });

        if (planIds.length > 0) {
            await tx.refinementIterationInput.createMany({
                data: planIds.map((planId) => ({ iterationId: iteration.id, planId })),
            });
        }

        logger.info("Refinement loop initialized", {
            loopId: loop.id,
            iterationId: iteration.id,
            organizationId: updater.organizationId,
            extra: { inputCount: planIds.length },
        });

        return {
            loopId: loop.id,
            organizationId: updater.organizationId,
            firstIterationId: iteration.id,
            hasPendingWork: planIds.length > 0,
        };
    });
}

/** Transitions an iteration to running. Called at the top of the iter body. */
export async function markRefinementIterationRunning(input: MarkRefinementIterationRunningInput): Promise<void> {
    const logger = rootLogger.child({ name: "markRefinementIterationRunning" });
    logger.info("Marking iteration as running");
    await db.refinementIteration.update({
        where: { id: input.iterationId },
        data: { status: "running" },
    });
}

export async function finishRefinementIteration(input: FinishRefinementIterationInput): Promise<void> {
    await db.refinementIteration.update({
        where: { id: input.iterationId },
        data: { status: "completed", finishedAt: new Date() },
    });
}

export async function finishRefinementLoop(input: FinishRefinementLoopInput): Promise<void> {
    await db.refinementLoop.update({
        where: { id: input.loopId },
        data: { status: input.status, finishedAt: new Date() },
    });
}
