import { type PrismaClient, type RefinementTrigger } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { GenerationOutcomeFailure, SystemBlockedOutcome } from "@autonoma/workflow/activities";

/** The outcome buckets for a set of plans. See {@link bucketPlanOutcomes}. */
export interface BucketedPlanOutcomes {
    validatedTestCaseIds: string[];
    failuresAtGeneration: GenerationOutcomeFailure[];
    systemBlocked: SystemBlockedOutcome[];
}

/** {@link BucketedPlanOutcomes} plus the iteration's loop/snapshot metadata. */
export interface BucketedIterationOutcomes extends BucketedPlanOutcomes {
    snapshotId: string;
    loopId: string;
    triggeredBy: RefinementTrigger;
    iterationNumber: number;
}

/**
 * The shared bucketing logic for a set of plans within a snapshot.
 *
 * A plan is validated purely by its generation review - there is no replay
 * step. For each plan, this resolves the latest generation in the snapshot,
 * joins its review, and splits them into three buckets:
 *
 *  - `validatedTestCaseIds` - the generation review passed.
 *  - `failuresAtGeneration` - the generation (or its review) failed (healable).
 *  - `systemBlocked`        - the generation failed with an un-healable infra
 *    failure (`scenario_setup`). Routed out of the healable buckets so the loop
 *    ignores them for convergence and never feeds them to the healing agent.
 *
 * Every input plan must have a generation in the snapshot: the diffs pipeline
 * seeds a pending generation for every affected test, and the loop's own
 * iterations generate the plans they own. A plan with no generation is a fatal
 * invariant violation in the upstream pipeline.
 */
export async function bucketPlanOutcomes(
    db: PrismaClient,
    snapshotId: string,
    planIds: string[],
    logger?: Logger,
): Promise<BucketedPlanOutcomes> {
    const log = logger ?? rootLogger.child({ name: "bucketPlanOutcomes" });

    if (planIds.length === 0) {
        log.info("No input plans to bucket");
        return { validatedTestCaseIds: [], failuresAtGeneration: [], systemBlocked: [] };
    }

    const generations = await db.testGeneration.findMany({
        // Exclude investigation shadow generations: this picks the latest generation per plan, so a newer
        // shadow row on an in-scope plan would bucket the outcome off the internal A/B measurement instead of
        // the real generation. Consistent with pendingGenerationPlanIds / fetchGenerations.
        where: { testPlanId: { in: planIds }, snapshotId, shadow: false },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            status: true,
            // `scenario_setup` failures route out of the healable buckets.
            failure: true,
            testPlan: {
                select: {
                    id: true,
                    prompt: true,
                    testCase: { select: { id: true, slug: true, name: true } },
                },
            },
            generationReview: {
                select: { id: true, verdict: true, reasoning: true, status: true },
            },
        },
    });

    const latestGenByPlan = new Map<string, (typeof generations)[number]>();
    for (const gen of generations) {
        if (!latestGenByPlan.has(gen.testPlan.id)) latestGenByPlan.set(gen.testPlan.id, gen);
    }

    const validatedTestCaseIds: string[] = [];
    const failuresAtGeneration: GenerationOutcomeFailure[] = [];
    const systemBlocked: SystemBlockedOutcome[] = [];

    for (const planId of planIds) {
        const generation = latestGenByPlan.get(planId);
        if (generation == null) {
            log.fatal("Input plan has no generation in the snapshot - invariant violated", { planId });
            throw new Error(
                `bucketPlanOutcomes: planId=${planId} has no TestGeneration in snapshot=${snapshotId}. ` +
                    `Every input plan must be generated (the diffs pipeline seeds a pending generation for each ` +
                    `affected test); investigate the upstream pipeline.`,
            );
        }

        const review = generation.generationReview;
        const isGenSuccess =
            generation.status === "success" && review?.status === "completed" && review.verdict === "success";

        if (isGenSuccess) {
            validatedTestCaseIds.push(generation.testPlan.testCase.id);
            continue;
        }

        const failure: GenerationOutcomeFailure = {
            failureKey: generation.id,
            testCaseId: generation.testPlan.testCase.id,
            testCaseSlug: generation.testPlan.testCase.slug,
            testCaseName: generation.testPlan.testCase.name,
            planId: generation.testPlan.id,
            planPrompt: generation.testPlan.prompt,
            sourceId: generation.id,
            sourceStatus: generation.status,
            verdictKind: review?.verdict ?? undefined,
            reviewReasoning: review?.reasoning ?? undefined,
            generationReviewId: review?.id ?? undefined,
        };
        if (generation.failure?.kind === "scenario_setup") systemBlocked.push(failure);
        else failuresAtGeneration.push(failure);
    }

    log.info("Bucketed plan outcomes", {
        extra: {
            validated: validatedTestCaseIds.length,
            failuresAtGeneration: failuresAtGeneration.length,
            systemBlocked: systemBlocked.length,
        },
    });

    return { validatedTestCaseIds, failuresAtGeneration, systemBlocked };
}

/**
 * Bucket one refinement iteration's plan outcomes. Resolves the iteration's
 * input plan ids and its loop/snapshot metadata, then delegates the bucketing to
 * {@link bucketPlanOutcomes}. The `analyzeResults` activity wraps it, and healing
 * eval-capture reuses it to rebuild the activity input from an iteration id when
 * the original input is no longer in hand.
 */
export async function bucketIterationOutcomes(
    db: PrismaClient,
    iterationId: string,
    logger?: Logger,
): Promise<BucketedIterationOutcomes> {
    const log = logger ?? rootLogger.child({ name: "bucketIterationOutcomes" });

    const iteration = await db.refinementIteration.findUniqueOrThrow({
        where: { id: iterationId },
        select: {
            number: true,
            inputs: { select: { planId: true } },
            loop: { select: { id: true, snapshotId: true, triggeredBy: true } },
        },
    });

    const planIds = iteration.inputs.map((i) => i.planId);
    const buckets = await bucketPlanOutcomes(db, iteration.loop.snapshotId, planIds, log);

    return {
        ...buckets,
        snapshotId: iteration.loop.snapshotId,
        loopId: iteration.loop.id,
        triggeredBy: iteration.loop.triggeredBy,
        iterationNumber: iteration.number,
    };
}
