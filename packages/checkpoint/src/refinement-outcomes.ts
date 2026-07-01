import type { GenerationReviewVerdict, GenerationStatus, RunReviewVerdict, RunStatus } from "@autonoma/db";

export interface TestCaseLite {
    id: string;
    name: string;
    slug: string;
}

export interface OutcomeValidated {
    planId: string;
    testCase: TestCaseLite;
    generationId: string;
    runId: string;
}

export interface OutcomeFailedAtGeneration {
    planId: string;
    testCase: TestCaseLite;
    generationId: string;
    generationStatus: GenerationStatus;
    verdictKind?: GenerationReviewVerdict;
    reviewReasoning?: string;
}

export interface OutcomeFailedAtReplay {
    planId: string;
    testCase: TestCaseLite;
    runId: string;
    runStatus: RunStatus;
    verdictKind?: RunReviewVerdict;
    reviewReasoning?: string;
}

export interface OutcomeAwaiting {
    planId: string;
    testCase: TestCaseLite;
}

export interface RefinementIterationOutcomes {
    validated: OutcomeValidated[];
    failedAtGeneration: OutcomeFailedAtGeneration[];
    failedAtReplay: OutcomeFailedAtReplay[];
    awaiting: OutcomeAwaiting[];
}

export interface RefinementGenerationRow {
    id: string;
    testPlanId: string;
    status: GenerationStatus;
    createdAt: Date;
    generationReview: { verdict: GenerationReviewVerdict | null; reasoning: string | null; status: string } | null;
}

export interface RefinementRunRow {
    id: string;
    planId: string | null;
    status: RunStatus;
    createdAt: Date;
    runReview: { verdict: RunReviewVerdict | null; reasoning: string | null; status: string } | null;
}

export function computeIterationOutcomes({
    inputs,
    cutoff,
    generations,
    runs,
}: {
    inputs: Array<{ planId: string; testCase: TestCaseLite }>;
    cutoff: Date;
    generations: RefinementGenerationRow[];
    runs: RefinementRunRow[];
}): RefinementIterationOutcomes {
    const outcomes: RefinementIterationOutcomes = {
        validated: [],
        failedAtGeneration: [],
        failedAtReplay: [],
        awaiting: [],
    };

    for (const input of inputs) {
        const gen = latestBeforeCutoff(
            generations.filter((g) => g.testPlanId === input.planId),
            cutoff,
        );
        if (gen == null) {
            outcomes.awaiting.push({ planId: input.planId, testCase: input.testCase });
            continue;
        }

        const review = gen.generationReview;
        const genSuccess =
            gen.status === "success" && review != null && review.status === "completed" && review.verdict === "success";

        if (!genSuccess) {
            outcomes.failedAtGeneration.push({
                planId: input.planId,
                testCase: input.testCase,
                generationId: gen.id,
                generationStatus: gen.status,
                verdictKind: review?.verdict ?? undefined,
                reviewReasoning: review?.reasoning ?? undefined,
            });
            continue;
        }

        const run = latestBeforeCutoff(
            runs.filter((r) => r.planId === input.planId),
            cutoff,
        );
        if (run == null) {
            outcomes.awaiting.push({ planId: input.planId, testCase: input.testCase });
            continue;
        }

        if (run.status === "success") {
            outcomes.validated.push({
                planId: input.planId,
                testCase: input.testCase,
                generationId: gen.id,
                runId: run.id,
            });
            continue;
        }

        const runReview = run.runReview;
        outcomes.failedAtReplay.push({
            planId: input.planId,
            testCase: input.testCase,
            runId: run.id,
            runStatus: run.status,
            verdictKind: runReview?.verdict ?? undefined,
            reviewReasoning: runReview?.reasoning ?? undefined,
        });
    }

    return outcomes;
}

function latestBeforeCutoff<T extends { createdAt: Date }>(rows: T[], cutoff: Date): T | undefined {
    let best: T | undefined;
    for (const row of rows) {
        if (row.createdAt.getTime() > cutoff.getTime()) continue;
        if (best == null || row.createdAt.getTime() > best.createdAt.getTime()) best = row;
    }
    return best;
}
