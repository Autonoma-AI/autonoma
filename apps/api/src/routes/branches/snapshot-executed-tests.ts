import type {
    GenerationReviewVerdict,
    GenerationStatus,
    Prisma,
    PrismaClient,
    RunReviewVerdict,
    RunStatus,
} from "@autonoma/db";
import { computeIterationOutcomes } from "./refinement-loop";

export type SnapshotExecutedTestFinalOutcome = "passed" | "failed" | "unresolved";

export interface SnapshotExecutedTest {
    source: "replay" | "generation" | "refinement";
    testCase: { id: string; name: string; slug: string };
    runId: string | null;
    generationId: string | null;
    status: RunStatus | GenerationStatus;
    finalOutcome: SnapshotExecutedTestFinalOutcome;
    verdict: RunReviewVerdict | GenerationReviewVerdict | null;
    reviewReasoning: string | null;
    startedAt: Date | null;
    completedAt: Date | null;
    createdAt: Date;
    latestRunAt: Date;
}

const runSelect = {
    id: true,
    status: true,
    startedAt: true,
    completedAt: true,
    createdAt: true,
    planId: true,
    assignment: { select: { testCaseId: true } },
    runReview: { select: { verdict: true, reasoning: true, status: true } },
} satisfies Prisma.RunSelect;

const generationSelect = {
    id: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    testPlan: {
        select: {
            id: true,
            testCaseId: true,
        },
    },
    generationReview: { select: { verdict: true, reasoning: true, status: true } },
} satisfies Prisma.TestGenerationSelect;

const refinementLoopSelect = {
    iterations: {
        orderBy: { number: "asc" },
        select: {
            id: true,
            number: true,
            status: true,
            startedAt: true,
            finishedAt: true,
            inputs: {
                select: {
                    planId: true,
                    plan: { select: { testCase: { select: { id: true, name: true, slug: true } } } },
                },
            },
        },
    },
} satisfies Prisma.RefinementLoopSelect;

type RunRow = Prisma.RunGetPayload<{ select: typeof runSelect }>;
type GenerationRow = Prisma.TestGenerationGetPayload<{ select: typeof generationSelect }>;
type RefinementLoopRow = Prisma.RefinementLoopGetPayload<{ select: typeof refinementLoopSelect }>;

export async function listExecutedTestsForSnapshot(
    db: PrismaClient,
    snapshotId: string,
): Promise<SnapshotExecutedTest[]> {
    const [assignments, runs, generations, refinementLoop] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId, quarantineIssueId: null },
            select: {
                testCaseId: true,
                testCase: { select: { id: true, name: true, slug: true } },
            },
        }),
        db.run.findMany({
            where: { assignment: { snapshotId, quarantineIssueId: null } },
            select: runSelect,
        }),
        db.testGeneration.findMany({
            where: {
                snapshotId,
                testPlan: {
                    testCase: {
                        assignments: {
                            some: { snapshotId, quarantineIssueId: null },
                        },
                    },
                },
            },
            select: generationSelect,
        }),
        db.refinementLoop.findUnique({
            where: { snapshotId },
            select: refinementLoopSelect,
        }),
    ]);

    const latestRunByTestCaseId = new Map<string, RunRow>();
    const latestGenerationByTestCaseId = new Map<string, GenerationRow>();
    const runById = new Map(runs.map((run) => [run.id, run]));
    const generationById = new Map(generations.map((generation) => [generation.id, generation]));

    for (const run of runs) {
        const testCaseId = run.assignment.testCaseId;
        const existing = latestRunByTestCaseId.get(testCaseId);
        if (existing == null || timeOf(run) > timeOf(existing)) {
            latestRunByTestCaseId.set(testCaseId, run);
        }
    }

    for (const generation of generations) {
        const testCaseId = generation.testPlan.testCaseId;
        const existing = latestGenerationByTestCaseId.get(testCaseId);
        if (existing == null || generation.updatedAt.getTime() > existing.updatedAt.getTime()) {
            latestGenerationByTestCaseId.set(testCaseId, generation);
        }
    }

    const refinementOutcomeByTestCaseId = computeFinalRefinementOutcomes({
        refinementLoop,
        generations,
        runs,
        runById,
        generationById,
    });

    return assignments
        .flatMap<SnapshotExecutedTest>((assignment) => {
            const refinementOutcome = refinementOutcomeByTestCaseId.get(assignment.testCaseId);
            if (refinementOutcome != null) return [refinementOutcome];

            const run = latestRunByTestCaseId.get(assignment.testCaseId);
            if (run != null) {
                return [
                    {
                        source: "replay" as const,
                        testCase: assignment.testCase,
                        runId: run.id,
                        generationId: null,
                        status: run.status,
                        finalOutcome: finalOutcomeForRunStatus(run.status),
                        verdict: run.runReview?.verdict ?? null,
                        reviewReasoning: run.runReview?.reasoning ?? null,
                        startedAt: run.startedAt,
                        completedAt: run.completedAt,
                        createdAt: run.createdAt,
                        latestRunAt: run.startedAt ?? run.createdAt,
                    },
                ];
            }

            const generation = latestGenerationByTestCaseId.get(assignment.testCaseId);
            if (generation == null) return [];

            return [
                {
                    source: "generation" as const,
                    testCase: assignment.testCase,
                    runId: null,
                    generationId: generation.id,
                    status: generation.status,
                    finalOutcome: finalOutcomeForGenerationStatus(generation.status),
                    verdict: generation.generationReview?.verdict ?? null,
                    reviewReasoning: generation.generationReview?.reasoning ?? null,
                    startedAt: null,
                    completedAt: null,
                    createdAt: generation.createdAt,
                    latestRunAt: generation.updatedAt,
                },
            ];
        })
        .sort((left, right) => left.testCase.name.localeCompare(right.testCase.name));
}

function timeOf(run: { startedAt: Date | null; createdAt: Date }): number {
    return run.startedAt?.getTime() ?? run.createdAt.getTime();
}

function computeFinalRefinementOutcomes({
    refinementLoop,
    generations,
    runs,
    runById,
    generationById,
}: {
    refinementLoop: RefinementLoopRow | null;
    generations: GenerationRow[];
    runs: RunRow[];
    runById: Map<string, RunRow>;
    generationById: Map<string, GenerationRow>;
}): Map<string, SnapshotExecutedTest> {
    const outcomes = new Map<string, SnapshotExecutedTest>();
    if (refinementLoop == null) return outcomes;

    for (const iteration of [...refinementLoop.iterations].reverse()) {
        const inputs = iteration.inputs.map((input) => ({
            planId: input.planId,
            testCase: input.plan.testCase,
        }));

        if (iteration.status !== "completed") {
            for (const input of inputs) {
                if (!outcomes.has(input.testCase.id))
                    outcomes.set(input.testCase.id, unresolvedRefinementRow(input, iteration));
            }
            continue;
        }

        const iterationOutcomes = computeIterationOutcomes({
            inputs,
            cutoff: iteration.finishedAt ?? iteration.startedAt,
            generations: generations.map((generation) => ({
                id: generation.id,
                testPlanId: generation.testPlan.id,
                status: generation.status,
                createdAt: generation.createdAt,
                generationReview: generation.generationReview,
            })),
            runs: runs.map((run) => ({
                id: run.id,
                planId: run.planId,
                status: run.status,
                createdAt: run.createdAt,
                runReview: run.runReview,
            })),
        });

        for (const outcome of iterationOutcomes.validated) {
            if (outcomes.has(outcome.testCase.id)) continue;
            const run = runById.get(outcome.runId);
            const generation = generationById.get(outcome.generationId);
            outcomes.set(outcome.testCase.id, {
                source: "replay",
                testCase: outcome.testCase,
                runId: outcome.runId,
                generationId: outcome.generationId,
                status: "success",
                finalOutcome: "passed",
                verdict: run?.runReview?.verdict ?? null,
                reviewReasoning: run?.runReview?.reasoning ?? null,
                startedAt: run?.startedAt ?? null,
                completedAt: run?.completedAt ?? null,
                createdAt: run?.createdAt ?? generation?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
                latestRunAt:
                    run?.startedAt ??
                    run?.createdAt ??
                    generation?.updatedAt ??
                    iteration.finishedAt ??
                    iteration.startedAt,
            });
        }

        for (const outcome of iterationOutcomes.failedAtReplay) {
            if (outcomes.has(outcome.testCase.id)) continue;
            const run = runById.get(outcome.runId);
            outcomes.set(outcome.testCase.id, {
                source: "replay",
                testCase: outcome.testCase,
                runId: outcome.runId,
                generationId: null,
                status: outcome.runStatus,
                finalOutcome: "failed",
                verdict: outcome.verdictKind ?? null,
                reviewReasoning: outcome.reviewReasoning ?? null,
                startedAt: run?.startedAt ?? null,
                completedAt: run?.completedAt ?? null,
                createdAt: run?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
                latestRunAt: run?.startedAt ?? run?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
            });
        }

        for (const outcome of iterationOutcomes.failedAtGeneration) {
            if (outcomes.has(outcome.testCase.id)) continue;
            const generation = generationById.get(outcome.generationId);
            outcomes.set(outcome.testCase.id, {
                source: "generation",
                testCase: outcome.testCase,
                runId: null,
                generationId: outcome.generationId,
                status: outcome.generationStatus,
                finalOutcome: "failed",
                verdict: outcome.verdictKind ?? null,
                reviewReasoning: outcome.reviewReasoning ?? null,
                startedAt: null,
                completedAt: null,
                createdAt: generation?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
                latestRunAt:
                    generation?.updatedAt ?? generation?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
            });
        }

        for (const outcome of iterationOutcomes.awaiting) {
            if (!outcomes.has(outcome.testCase.id))
                outcomes.set(outcome.testCase.id, unresolvedRefinementRow(outcome, iteration));
        }
    }

    return outcomes;
}

function unresolvedRefinementRow(
    input: { planId: string; testCase: { id: string; name: string; slug: string } },
    iteration: RefinementLoopRow["iterations"][number],
): SnapshotExecutedTest {
    const at = iteration.finishedAt ?? iteration.startedAt;
    return {
        source: "refinement",
        testCase: input.testCase,
        runId: null,
        generationId: null,
        status: "pending",
        finalOutcome: "unresolved",
        verdict: null,
        reviewReasoning: null,
        startedAt: null,
        completedAt: null,
        createdAt: at,
        latestRunAt: at,
    };
}

export function finalOutcomeForRunStatus(status: RunStatus): SnapshotExecutedTestFinalOutcome {
    if (status === "success") return "passed";
    if (status === "failed") return "failed";
    return "unresolved";
}

export function finalOutcomeForGenerationStatus(status: GenerationStatus): SnapshotExecutedTestFinalOutcome {
    if (status === "failed") return "failed";
    return "unresolved";
}
