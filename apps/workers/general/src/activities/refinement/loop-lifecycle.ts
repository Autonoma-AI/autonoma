import type { Prisma } from "@autonoma/db";
import { type RefinementTrigger, db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater } from "@autonoma/test-updates";
import type {
    FinishErroredRefinementIterationsInput,
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
 *   - Seeds iteration 1's RefinementIterationInput rows by trigger (see
 *     {@link seedFirstIterationPlanIds}).
 *
 * `runFirstIterationPipeline` lets the workflow skip the iter-1 generation
 * pipeline child when iter 1 has nothing to generate. It is true iff the
 * snapshot has pending generations when the loop starts - one rule for both
 * flows (onboarding's planner-queued gens, or the diffs agent's authored tests).
 *
 * Invariant this depends on: at trigger time, the seed set is exactly the plans
 * that need refinement. Maintained by the upstream flows that trigger the loop:
 *
 *   - Diffs: analysis queues a pending generation for every affected test (so
 *     the affected tests' plans are part of iter 1's scope), alongside the new
 *     tests the diffs agent authored, which also carry pending generations that
 *     iter 1's pipeline generates. The seed set is the union of both.
 *   - Onboarding: `AddTest` changes during snapshot setup queue pending gens
 *     for every test the loop should validate; `addJob`'s per-test-case dedup
 *     prevents stale pending rows from accumulating.
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
        const { planIds, runFirstIterationPipeline } = await seedFirstIterationPlanIds(
            tx,
            input.snapshotId,
            input.triggeredBy,
            logger,
        );

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
            extra: { inputCount: planIds.length, runFirstIterationPipeline },
        });

        return {
            loopId: loop.id,
            organizationId: updater.organizationId,
            firstIterationId: iteration.id,
            runFirstIterationPipeline,
        };
    });
}

interface SeededFirstIteration {
    /** The plan ids that make up iteration 1's analysis scope. */
    planIds: string[];
    /**
     * Whether iteration 1 has pending generations the iter-1 pipeline must
     * generate. True iff the snapshot has any pending generation.
     */
    runFirstIterationPipeline: boolean;
}

/**
 * Seed iteration 1's input plan ids from the snapshot's pending generations.
 *
 * Both triggers now seed identically, because both stage their iter-1 work as
 * pending generations before the loop starts:
 *
 *   - Diffs: analysis queues a pending generation for every affected test (from
 *     its committed plan) as well as the new tests the diffs agent authored.
 *   - Onboarding: the planner's pending generations (the work the loop must
 *     finish before activating the snapshot).
 *
 * A generation passing its review is the definition of "validated" - there is no
 * replay step. `runFirstIterationPipeline` is true iff the snapshot has any
 * pending generation.
 */
async function seedFirstIterationPlanIds(
    tx: Prisma.TransactionClient,
    snapshotId: string,
    triggeredBy: RefinementTrigger,
    logger: Logger,
): Promise<SeededFirstIteration> {
    const pendingGenPlanIds = await pendingGenerationPlanIds(tx, snapshotId);
    const runFirstIterationPipeline = pendingGenPlanIds.length > 0;
    logger.info("Seeded iteration 1", {
        extra: { triggeredBy, planIds: pendingGenPlanIds.length },
    });
    return { planIds: pendingGenPlanIds, runFirstIterationPipeline };
}

/** The snapshot's pending generations, one plan id per generation (deduped + invariant-checked). */
async function pendingGenerationPlanIds(tx: Prisma.TransactionClient, snapshotId: string): Promise<string[]> {
    // Exclude investigation shadow generations: they are queued outside addJob and can orphan in `pending`, so
    // counting them here would both break the per-test-case invariant below and pull them into the loop's scope.
    const pending = await tx.testGeneration.findMany({
        where: { snapshotId, status: "pending", shadow: false },
        select: { testPlanId: true },
    });

    // Assert addJob's per-test-case invariant: at most one pending generation per
    // testPlan in a snapshot. If this fires, something queued generations outside
    // the documented flows and the loop's "pending = my scope" semantics break.
    const planIds = pending.map((g) => g.testPlanId);
    const seenPlanIds = new Set<string>();
    const duplicatePlanIds = new Set<string>();
    for (const planId of planIds) {
        if (seenPlanIds.has(planId)) duplicatePlanIds.add(planId);
        else seenPlanIds.add(planId);
    }
    if (duplicatePlanIds.size > 0) {
        throw new Error(
            `Multiple pending generations exist for the same plan(s) in snapshot ${snapshotId}: ` +
                `${[...duplicatePlanIds].join(", ")}. addJob's per-test-case dedup should make this impossible; ` +
                `investigate which path is queueing generations outside the expected flows.`,
        );
    }

    return planIds;
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

export async function finishErroredRefinementIterations(input: FinishErroredRefinementIterationsInput): Promise<void> {
    await db.refinementIteration.updateMany({
        where: {
            loopId: input.loopId,
            status: { in: ["pending", "running"] },
            finishedAt: null,
        },
        data: { status: "completed", finishedAt: new Date() },
    });
}

export async function finishRefinementLoop(input: FinishRefinementLoopInput): Promise<void> {
    await db.refinementLoop.update({
        where: { id: input.loopId },
        data: { status: input.status, finishedAt: new Date() },
    });
}
