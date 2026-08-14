import type { GenerationStatus, Prisma, PrismaClient } from "@autonoma/db";

export type SnapshotExecutedTestFinalOutcome = "passed" | "failed" | "setup_failed" | "unresolved";

export interface SnapshotExecutedTest {
    source: "generation";
    testCase: { id: string; name: string; slug: string };
    generationId: string | null;
    status: GenerationStatus;
    finalOutcome: SnapshotExecutedTestFinalOutcome;
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
} satisfies Prisma.TestGenerationSelect;

const assignmentSelect = {
    testCaseId: true,
    testCase: { select: { id: true, name: true, slug: true } },
} satisfies Prisma.TestCaseAssignmentSelect;

type GenerationRow = Prisma.TestGenerationGetPayload<{ select: typeof generationSelect }>;
type AssignmentRow = Prisma.TestCaseAssignmentGetPayload<{ select: typeof assignmentSelect }>;

export async function listExecutedTestsForSnapshot(
    db: PrismaClient,
    snapshotId: string,
): Promise<SnapshotExecutedTest[]> {
    const [assignments, generations] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId },
            select: assignmentSelect,
        }),
        db.testGeneration.findMany({
            where: {
                snapshotId,
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
    ]);

    return buildExecutedTests(assignments, generations);
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

    const [assignments, generations] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId: { in: snapshotIds } },
            select: { ...assignmentSelect, snapshotId: true },
        }),
        db.testGeneration.findMany({
            where: {
                snapshotId: { in: snapshotIds },
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
    ]);

    const assignmentsBySnapshot = groupBy(assignments, (a) => a.snapshotId);
    const generationsBySnapshot = groupBy(generations, (g) => g.snapshotId);
    const result = new Map<string, SnapshotExecutedTest[]>();
    for (const snapshotId of snapshotIds) {
        result.set(
            snapshotId,
            buildExecutedTests(
                assignmentsBySnapshot.get(snapshotId) ?? [],
                generationsBySnapshot.get(snapshotId) ?? [],
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

function buildExecutedTests(assignments: AssignmentRow[], generations: GenerationRow[]): SnapshotExecutedTest[] {
    const latestGenerationByTestCaseId = new Map<string, GenerationRow>();

    for (const generation of generations) {
        const testCaseId = generation.testPlan.testCaseId;
        const existing = latestGenerationByTestCaseId.get(testCaseId);
        if (existing == null || generation.updatedAt.getTime() > existing.updatedAt.getTime()) {
            latestGenerationByTestCaseId.set(testCaseId, generation);
        }
    }

    return assignments
        .flatMap<SnapshotExecutedTest>((assignment) => {
            const generation = latestGenerationByTestCaseId.get(assignment.testCaseId);
            if (generation == null) return [];

            return [
                {
                    source: "generation" as const,
                    testCase: assignment.testCase,
                    generationId: generation.id,
                    status: generation.status,
                    finalOutcome: finalOutcomeForGeneration(generation.status, generation.failure),
                    createdAt: generation.createdAt,
                    latestRunAt: generation.updatedAt,
                },
            ];
        })
        .sort((left, right) => left.testCase.name.localeCompare(right.testCase.name));
}

function finalOutcomeForGeneration(
    status: GenerationStatus,
    failure: GenerationRow["failure"],
): SnapshotExecutedTestFinalOutcome {
    // A scenario-setup failure means the test never got a chance to run (the environment never came up), so it
    // surfaces as the distinct `setup_failed` outcome; every other kind (engine_error, agent_failed, max_steps)
    // is a real `failed`.
    if (status === "failed") return failure?.kind === "scenario_setup" ? "setup_failed" : "failed";
    // Otherwise the engine's own outcome, which is all this view has: a generation that finished is passed, one
    // still in flight is unresolved. An authoritative snapshot's real verdict lives on its AnalysisClassification
    // and is read through the analysis surfaces, never here.
    return status === "success" ? "passed" : "unresolved";
}
