import { db } from "@autonoma/db";
import { extendObservabilityContext, logger as rootLogger } from "@autonoma/logger";
import type {
    AnalyzeResultsInput,
    AnalyzeResultsOutput,
    GenerationOutcomeFailure,
    RunOutcomeFailure,
} from "@autonoma/workflow/activities";

/**
 * Reads the outcomes of every plan in a refinement iteration's input set and
 * buckets them. Resolves three sources per plan:
 *
 *   1. The latest TestGeneration for the plan in the iteration's snapshot.
 *   2. Its review.
 *   3. The latest Run for the plan in the snapshot (via Run.planId) and its review.
 *
 * Validated test cases are those whose run succeeded. Failures are split by
 * which stage they died at, matching the existing GenerationOutcomeFailure /
 * RunOutcomeFailure shapes for downstream healing.
 *
 * By construction (runGenerationPipeline guarantees a generation exists for
 * every input plan), the "no generation found" case is unreachable - if it
 * happens we log fatal and synthesize a generation failure so the loop can
 * continue rather than crash.
 */
export async function analyzeResults(input: AnalyzeResultsInput): Promise<AnalyzeResultsOutput> {
    const logger = rootLogger.child({ name: "analyzeResults" });
    logger.info("Analyzing iteration results");

    const iteration = await db.refinementIteration.findUniqueOrThrow({
        where: { id: input.iterationId },
        select: {
            number: true,
            inputs: { select: { planId: true } },
            loop: { select: { id: true, snapshotId: true, triggeredBy: true } },
        },
    });

    const planIds = iteration.inputs.map((i) => i.planId);
    const snapshotId = iteration.loop.snapshotId;
    extendObservabilityContext({
        snapshot: { snapshotId },
        refinementLoop: { loopId: iteration.loop.id, triggeredBy: iteration.loop.triggeredBy },
        refinementIteration: { iterationId: input.iterationId, iterationNumber: iteration.number },
    });

    if (planIds.length === 0) {
        logger.info("Iteration has no input plans; nothing to analyze");
        return { validatedTestCaseIds: [], failuresAtGeneration: [], failuresAtReplay: [] };
    }

    const generations = await db.testGeneration.findMany({
        where: { testPlanId: { in: planIds }, snapshotId },
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            status: true,
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
            assignment: { select: { testCaseId: true } },
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

    for (const planId of planIds) {
        const generation = latestGenByPlan.get(planId);

        if (generation == null) {
            logger.fatal("Input plan has no generation in this snapshot - invariant violated", { planId });
            throw new Error(
                `analyzeResults: no TestGeneration found for planId=${planId} in snapshot=${snapshotId} ` +
                    `(iteration=${input.iterationId}). The refinement loop's pre-fire step must have created ` +
                    `one before this activity ran; investigate the upstream pipeline (runGenerationPipelineWorkflow).`,
            );
        }

        const review = generation.generationReview;
        const isGenSuccess =
            generation.status === "success" && review?.status === "completed" && review.verdict === "success";

        if (!isGenSuccess) {
            failuresAtGeneration.push({
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
            });
            continue;
        }

        const run = latestRunByPlan.get(planId);
        if (run == null) {
            logger.fatal("Generation succeeded but no run exists for plan - invariant violated", {
                planId,
                testGenerationId: generation.id,
            });
            throw new Error(
                `analyzeResults: TestGeneration ${generation.id} for planId=${planId} succeeded but no ` +
                    `Run exists for that plan in snapshot=${snapshotId}. The refinement loop's pre-fire step ` +
                    `must have created one via prepareRunsForGenerations; investigate runGenerationPipelineWorkflow.`,
            );
        }

        if (run.status === "success") {
            validatedTestCaseIds.push(run.assignment.testCaseId);
            continue;
        }

        const runReview = run.runReview;
        failuresAtReplay.push({
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
        });
    }

    logger.info("Analysis complete", {
        extra: {
            validated: validatedTestCaseIds.length,
            failuresAtGeneration: failuresAtGeneration.length,
            failuresAtReplay: failuresAtReplay.length,
        },
    });

    return { validatedTestCaseIds, failuresAtGeneration, failuresAtReplay };
}
