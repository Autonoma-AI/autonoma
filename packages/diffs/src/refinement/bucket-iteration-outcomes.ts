import { type PrismaClient, type RefinementTrigger } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { GenerationOutcomeFailure, RunOutcomeFailure, SystemBlockedOutcome } from "@autonoma/workflow/activities";

/** The outcome buckets for a set of plans. See {@link bucketPlanOutcomes}. */
export interface BucketedPlanOutcomes {
    validatedTestCaseIds: string[];
    failuresAtGeneration: GenerationOutcomeFailure[];
    failuresAtReplay: RunOutcomeFailure[];
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
 * For each plan, this resolves the latest generation and run in the snapshot,
 * joins their reviews, and splits them into four buckets:
 *
 *  - `validatedTestCaseIds` - the run succeeded.
 *  - `failuresAtGeneration` - generation (or its review) failed (healable).
 *  - `failuresAtReplay`     - a run (or its review) failed (healable): either
 *    after a passing generation, or replay-only (a pre-existing test replayed
 *    with no generation).
 *  - `systemBlocked`        - generation/run failed with an un-healable infra
 *    failure (`scenario_setup`). Routed out of the healable buckets so the loop
 *    ignores them for convergence and never feeds them to the healing agent.
 *
 * The bucketing invariants are load-bearing for every caller, so this helper is
 * the single source of truth:
 *
 *  - A plan with a generation buckets through the generation path; a passing
 *    generation must have a run (else fatal).
 *  - A plan with a run but no generation is a *replay-only* outcome (e.g.
 *    seeding a first turn from replays): it buckets purely by its run result,
 *    with no generation review.
 *  - A plan with neither a generation nor a run is the fatal violation.
 *
 * Callers resolve which plans to bucket however suits them: {@link bucketIterationOutcomes}
 * from a refinement iteration's inputs (the `analyzeResults` activity), and
 * healing eval-capture of a folded-resolution first turn from the affected-test
 * replays.
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
        return { validatedTestCaseIds: [], failuresAtGeneration: [], failuresAtReplay: [], systemBlocked: [] };
    }

    const generations = await db.testGeneration.findMany({
        where: { testPlanId: { in: planIds }, snapshotId },
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

    const runs = await db.run.findMany({
        where: {
            planId: { in: planIds },
            assignment: { snapshotId },
        },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            status: true,
            planId: true,
            // `scenario_setup` failures route out of the healable buckets.
            failure: true,
            // plan prompt + test case let a replay-only outcome (no generation)
            // carry the same plan/test-case context the generation path sources
            // from its generation's plan.
            plan: { select: { prompt: true } },
            assignment: { select: { testCaseId: true, testCase: { select: { slug: true, name: true } } } },
            runReview: { select: { id: true, verdict: true, reasoning: true, status: true } },
        },
    });

    const latestRunByPlan = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
        if (run.planId != null && !latestRunByPlan.has(run.planId)) latestRunByPlan.set(run.planId, run);
    }

    const validatedTestCaseIds: string[] = [];
    const failuresAtGeneration: GenerationOutcomeFailure[] = [];
    const failuresAtReplay: RunOutcomeFailure[] = [];
    const systemBlocked: SystemBlockedOutcome[] = [];

    for (const planId of planIds) {
        const generation = latestGenByPlan.get(planId);
        const run = latestRunByPlan.get(planId);

        // Replay-only outcome (#951): a pre-existing test replayed against the
        // diff has a run but no generation (e.g. seeding a first turn from
        // replays). Bucket it purely by its run result, with no generation
        // review. A plan with neither a generation nor a (plan-linked) run is
        // the fatal violation.
        if (generation == null) {
            const plan = run?.plan;
            if (run == null || plan == null) {
                log.fatal("Input plan has neither a generation nor a plan-linked run - invariant violated", {
                    planId,
                    runId: run?.id,
                });
                throw new Error(
                    `bucketPlanOutcomes: planId=${planId} has no TestGeneration and no plan-linked Run in ` +
                        `snapshot=${snapshotId}. An input plan must have at least a generation, or a replay-only ` +
                        `run that references its plan; investigate the upstream pipeline.`,
                );
            }

            if (run.status === "success") {
                validatedTestCaseIds.push(run.assignment.testCaseId);
                continue;
            }

            const runReview = run.runReview;
            const failure: RunOutcomeFailure = {
                bucket: "failed_at_replay",
                failureKey: run.id,
                testCaseId: run.assignment.testCaseId,
                testCaseSlug: run.assignment.testCase.slug,
                testCaseName: run.assignment.testCase.name,
                planId,
                planPrompt: plan.prompt,
                sourceId: run.id,
                sourceStatus: run.status,
                verdictKind: runReview?.verdict ?? undefined,
                reviewReasoning: runReview?.reasoning ?? undefined,
                runReviewId: runReview?.id ?? undefined,
            };
            if (run.failure?.kind === "scenario_setup") systemBlocked.push(failure);
            else failuresAtReplay.push(failure);
            continue;
        }

        const review = generation.generationReview;
        const isGenSuccess =
            generation.status === "success" && review?.status === "completed" && review.verdict === "success";

        if (!isGenSuccess) {
            const failure: GenerationOutcomeFailure = {
                bucket: "failed_at_generation",
                failureKey: generation.id,
                testCaseId: generation.testPlan.testCase.id,
                testCaseSlug: generation.testPlan.testCase.slug,
                testCaseName: generation.testPlan.testCase.name,
                planId: generation.testPlan.id,
                planPrompt: generation.testPlan.prompt,
                sourceId: generation.id,
                sourceStatus: generation.status,
                verdictKind: (review?.verdict ?? undefined) as GenerationOutcomeFailure["verdictKind"],
                reviewReasoning: review?.reasoning ?? undefined,
                generationReviewId: review?.id ?? undefined,
            };
            if (generation.failure?.kind === "scenario_setup") systemBlocked.push(failure);
            else failuresAtGeneration.push(failure);
            continue;
        }

        if (run == null) {
            log.fatal("Generation succeeded but no run exists for plan - invariant violated", {
                planId,
                testGenerationId: generation.id,
            });
            throw new Error(
                `bucketPlanOutcomes: TestGeneration ${generation.id} for planId=${planId} succeeded but no ` +
                    `Run exists for that plan in snapshot=${snapshotId}. The refinement loop's pre-fire step ` +
                    `must have created one via prepareRunsForGenerations; investigate runGenerationPipelineWorkflow.`,
            );
        }

        if (run.status === "success") {
            validatedTestCaseIds.push(run.assignment.testCaseId);
            continue;
        }

        const runReview = run.runReview;
        const failure: RunOutcomeFailure = {
            bucket: "failed_at_replay",
            failureKey: run.id,
            testCaseId: run.assignment.testCaseId,
            testCaseSlug: generation.testPlan.testCase.slug,
            testCaseName: generation.testPlan.testCase.name,
            planId: generation.testPlan.id,
            planPrompt: generation.testPlan.prompt,
            sourceId: run.id,
            sourceStatus: run.status,
            verdictKind: (runReview?.verdict ?? undefined) as RunOutcomeFailure["verdictKind"],
            reviewReasoning: runReview?.reasoning ?? undefined,
            runReviewId: runReview?.id ?? undefined,
        };
        if (run.failure?.kind === "scenario_setup") systemBlocked.push(failure);
        else failuresAtReplay.push(failure);
    }

    log.info("Bucketed plan outcomes", {
        extra: {
            validated: validatedTestCaseIds.length,
            failuresAtGeneration: failuresAtGeneration.length,
            failuresAtReplay: failuresAtReplay.length,
            systemBlocked: systemBlocked.length,
        },
    });

    return { validatedTestCaseIds, failuresAtGeneration, failuresAtReplay, systemBlocked };
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
