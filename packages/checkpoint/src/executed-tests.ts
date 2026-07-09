import type { GenerationReviewVerdict, GenerationStatus, Prisma, PrismaClient } from "@autonoma/db";
import { computeIterationOutcomes } from "./refinement-outcomes";

export type SnapshotExecutedTestFinalOutcome = "passed" | "failed" | "setup_failed" | "unresolved";

export interface SnapshotExecutedTest {
    source: "generation" | "refinement";
    testCase: { id: string; name: string; slug: string };
    generationId: string | null;
    status: GenerationStatus;
    finalOutcome: SnapshotExecutedTestFinalOutcome;
    verdict: GenerationReviewVerdict | null;
    reviewReasoning: string | null;
    createdAt: Date;
    latestRunAt: Date;
}

const generationSelect = {
    id: true,
    snapshotId: true,
    status: true,
    failure: true,
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

const assignmentSelect = {
    testCaseId: true,
    testCase: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.TestCaseAssignmentSelect;

const refinementLoopSelect = {
    status: true,
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

type GenerationRow = Prisma.TestGenerationGetPayload<{ select: typeof generationSelect }>;
type RefinementLoopRow = Prisma.RefinementLoopGetPayload<{ select: typeof refinementLoopSelect }>;
type AssignmentRow = Prisma.TestCaseAssignmentGetPayload<{ select: typeof assignmentSelect }>;

export async function listExecutedTestsForSnapshot(
    db: PrismaClient,
    snapshotId: string,
): Promise<SnapshotExecutedTest[]> {
    const [assignments, generations, refinementLoop] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId },
            select: assignmentSelect,
        }),
        db.testGeneration.findMany({
            where: {
                snapshotId,
                shadow: false,
                testPlan: {
                    testCase: {
                        assignments: {
                            some: { snapshotId },
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

    return buildExecutedTests(assignments, generations, refinementLoop);
}

/**
 * Bulk equivalent of {@link listExecutedTestsForSnapshot} for many snapshots at
 * once. Issues a fixed number of queries (one per relation, scoped with `IN`)
 * instead of fanning out four queries per snapshot, then groups the rows in
 * memory and runs the exact same assembly logic per snapshot. Used by list
 * views (PR list, snapshot history) that need health for every snapshot without
 * an N+1 explosion.
 */
export async function listExecutedTestsForSnapshots(
    db: PrismaClient,
    snapshotIds: string[],
): Promise<Map<string, SnapshotExecutedTest[]>> {
    if (snapshotIds.length === 0) return new Map();

    const [assignments, generations, refinementLoops] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId: { in: snapshotIds } },
            select: { ...assignmentSelect, snapshotId: true },
        }),
        db.testGeneration.findMany({
            where: {
                snapshotId: { in: snapshotIds },
                shadow: false,
                testPlan: {
                    testCase: {
                        assignments: {
                            some: { snapshotId: { in: snapshotIds } },
                        },
                    },
                },
            },
            select: generationSelect,
        }),
        db.refinementLoop.findMany({
            where: { snapshotId: { in: snapshotIds } },
            select: { ...refinementLoopSelect, snapshotId: true },
        }),
    ]);

    const assignmentsBySnapshot = groupBy(assignments, (a) => a.snapshotId);
    const generationsBySnapshot = groupBy(generations, (g) => g.snapshotId);
    const refinementLoopBySnapshot = new Map(refinementLoops.map((loop) => [loop.snapshotId, loop]));

    const result = new Map<string, SnapshotExecutedTest[]>();
    for (const snapshotId of snapshotIds) {
        result.set(
            snapshotId,
            buildExecutedTests(
                assignmentsBySnapshot.get(snapshotId) ?? [],
                generationsBySnapshot.get(snapshotId) ?? [],
                refinementLoopBySnapshot.get(snapshotId) ?? null,
            ),
        );
    }
    return result;
}

function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = keyOf(item);
        let group = groups.get(key);
        if (group == null) {
            group = [];
            groups.set(key, group);
        }
        group.push(item);
    }
    return groups;
}

function buildExecutedTests(
    assignments: AssignmentRow[],
    generations: GenerationRow[],
    refinementLoop: RefinementLoopRow | null,
): SnapshotExecutedTest[] {
    const latestGenerationByTestCaseId = new Map<string, GenerationRow>();
    const generationById = new Map(generations.map((generation) => [generation.id, generation]));

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
        generationById,
    });

    return assignments
        .flatMap<SnapshotExecutedTest>((assignment) => {
            const refinementOutcome = refinementOutcomeByTestCaseId.get(assignment.testCaseId);
            if (refinementOutcome != null) return [refinementOutcome];

            const generation = latestGenerationByTestCaseId.get(assignment.testCaseId);
            if (generation == null) return [];

            return [
                {
                    source: "generation" as const,
                    testCase: assignment.testCase,
                    generationId: generation.id,
                    status: generation.status,
                    finalOutcome: finalOutcomeForGenerationStatus(
                        generation.status,
                        generation.failure,
                        generation.generationReview,
                    ),
                    verdict: generation.generationReview?.verdict ?? null,
                    reviewReasoning:
                        generation.generationReview?.reasoning ?? setupFailureMessage(generation.failure) ?? null,
                    createdAt: generation.createdAt,
                    latestRunAt: generation.updatedAt,
                },
            ];
        })
        .sort((left, right) => left.testCase.name.localeCompare(right.testCase.name));
}

function computeFinalRefinementOutcomes({
    refinementLoop,
    generations,
    generationById,
}: {
    refinementLoop: RefinementLoopRow | null;
    generations: GenerationRow[];
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
            // Once the loop has terminated, a trailing pending/running iteration is stale; skip it so
            // its inputs resolve to their last completed iteration.
            if (refinementLoop.status !== "running") continue;
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
        });

        for (const outcome of iterationOutcomes.validated) {
            if (outcomes.has(outcome.testCase.id)) continue;
            const generation = generationById.get(outcome.generationId);
            outcomes.set(outcome.testCase.id, {
                source: "generation",
                testCase: outcome.testCase,
                generationId: outcome.generationId,
                status: "success",
                finalOutcome: "passed",
                verdict: generation?.generationReview?.verdict ?? null,
                reviewReasoning: generation?.generationReview?.reasoning ?? null,
                createdAt: generation?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
                latestRunAt:
                    generation?.updatedAt ?? generation?.createdAt ?? iteration.finishedAt ?? iteration.startedAt,
            });
        }

        for (const outcome of iterationOutcomes.failedAtGeneration) {
            if (outcomes.has(outcome.testCase.id)) continue;
            const generation = generationById.get(outcome.generationId);
            outcomes.set(outcome.testCase.id, {
                source: "generation",
                testCase: outcome.testCase,
                generationId: outcome.generationId,
                status: outcome.generationStatus,
                finalOutcome: terminalFailureOutcome(generation?.failure ?? null),
                verdict: outcome.verdictKind ?? null,
                reviewReasoning: outcome.reviewReasoning ?? setupFailureMessage(generation?.failure ?? null) ?? null,
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
        generationId: null,
        status: "pending",
        finalOutcome: "unresolved",
        verdict: null,
        reviewReasoning: null,
        createdAt: at,
        latestRunAt: at,
    };
}

type SystemFailureRow = GenerationRow["failure"];

export function finalOutcomeForGenerationStatus(
    status: GenerationStatus,
    failure: GenerationRow["failure"],
    review: GenerationRow["generationReview"],
): SnapshotExecutedTestFinalOutcome {
    if (status === "failed") return terminalFailureOutcome(failure);
    // A generation's pass/fail is the GenerationReview verdict, not the agent's
    // self-reported status: the agent can finish (status "success") while the
    // review still judges the outcome a non-pass (e.g. plan_mismatch). Until the
    // review completes, the outcome is unresolved.
    if (status !== "success") return "unresolved";
    if (review == null || review.status !== "completed") return "unresolved";
    return review.verdict === "success" ? "passed" : "failed";
}

/**
 * Maps a terminal failure to its outcome bucket. A scenario-setup failure means
 * the test never got a chance to run (the environment never came up), so it
 * surfaces as the distinct `setup_failed` outcome; every other failure kind
 * (engine_error, agent_failed, max_steps) is a real `failed`.
 */
function terminalFailureOutcome(failure: SystemFailureRow): SnapshotExecutedTestFinalOutcome {
    return failure?.kind === "scenario_setup" ? "setup_failed" : "failed";
}

/** The human-readable reason to surface for a scenario-setup failure, if any. */
function setupFailureMessage(failure: SystemFailureRow): string | undefined {
    if (failure?.kind === "scenario_setup") return failure.message;
    return undefined;
}
