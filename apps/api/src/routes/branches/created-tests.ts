import type {
    GenerationReviewVerdict,
    GenerationStatus,
    IssueKind,
    Prisma,
    PrismaClient,
    RunReviewVerdict,
    RunStatus,
} from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";

export interface CreatedTestGeneration {
    id: string;
    status: GenerationStatus;
    verdict?: GenerationReviewVerdict;
    reviewReasoning?: string;
}

export interface CreatedTestRun {
    id: string;
    status: RunStatus;
    verdict?: RunReviewVerdict;
    reviewReasoning?: string;
}

/**
 * A test the diffs agent (or onboarding) authored during this snapshot's
 * analysis. Each carries the durable description (the test's intent) plus the
 * `generation -> run` pipeline that generated and validated it in the refinement
 * loop.
 */
export interface SnapshotCreatedTest {
    testCase: { id: string; name: string; slug: string; folderId: string };
    description?: string;
    plan: string;
    generation?: CreatedTestGeneration;
    run?: CreatedTestRun;
    quarantine?: { issueId: string; reason: IssueKind; bugId?: string };
}

const assignmentSelect = {
    testCaseId: true,
    testCase: { select: { id: true, name: true, slug: true, folderId: true, description: true } },
    plan: { select: { prompt: true } },
    quarantineIssue: { select: { id: true, kind: true, bugId: true } },
} satisfies Prisma.TestCaseAssignmentSelect;

const generationSelect = {
    id: true,
    status: true,
    createdAt: true,
    updatedAt: true,
    testPlan: { select: { testCaseId: true } },
    generationReview: { select: { verdict: true, reasoning: true } },
} satisfies Prisma.TestGenerationSelect;

const runSelect = {
    id: true,
    status: true,
    startedAt: true,
    createdAt: true,
    assignment: { select: { testCaseId: true } },
    runReview: { select: { verdict: true, reasoning: true } },
} satisfies Prisma.RunSelect;

type AssignmentRow = Prisma.TestCaseAssignmentGetPayload<{ select: typeof assignmentSelect }>;
type GenerationRow = Prisma.TestGenerationGetPayload<{ select: typeof generationSelect }>;
type RunRow = Prisma.RunGetPayload<{ select: typeof runSelect }>;

/**
 * Loads the tests created in this snapshot (those whose assignment is new
 * relative to the previous snapshot, identified by the caller from the snapshot
 * changes) together with their description (the test's durable intent) and the
 * latest generation + run that authored and validated each one.
 *
 * Sourced from the assignments + generations created during analysis.
 */
export async function loadCreatedTests(
    db: PrismaClient,
    snapshotId: string,
    createdTestCaseIds: string[],
    parentLogger?: Logger,
): Promise<SnapshotCreatedTest[]> {
    const logger = (parentLogger ?? rootLogger).child({ name: "loadCreatedTests", snapshotId });
    if (createdTestCaseIds.length === 0) return [];

    logger.info("Loading created tests", { extra: { count: createdTestCaseIds.length } });

    const [assignments, generations, runs] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId, testCaseId: { in: createdTestCaseIds } },
            select: assignmentSelect,
        }),
        db.testGeneration.findMany({
            where: { snapshotId, testPlan: { testCaseId: { in: createdTestCaseIds } } },
            select: generationSelect,
        }),
        db.run.findMany({
            where: { assignment: { snapshotId, testCaseId: { in: createdTestCaseIds } } },
            select: runSelect,
        }),
    ]);

    const latestGenByTestCase = pickLatest(
        generations,
        (g) => g.testPlan.testCaseId,
        (g) => g.updatedAt.getTime(),
    );
    const latestRunByTestCase = pickLatest(
        runs,
        (r) => r.assignment.testCaseId,
        (r) => (r.startedAt ?? r.createdAt).getTime(),
    );

    return assignments
        .map((assignment) => buildCreatedTest(assignment, latestGenByTestCase, latestRunByTestCase))
        .sort((left, right) => left.testCase.name.localeCompare(right.testCase.name));
}

function buildCreatedTest(
    assignment: AssignmentRow,
    latestGenByTestCase: Map<string, GenerationRow>,
    latestRunByTestCase: Map<string, RunRow>,
): SnapshotCreatedTest {
    const generation = latestGenByTestCase.get(assignment.testCaseId);
    const run = latestRunByTestCase.get(assignment.testCaseId);

    return {
        testCase: {
            id: assignment.testCase.id,
            name: assignment.testCase.name,
            slug: assignment.testCase.slug,
            folderId: assignment.testCase.folderId,
        },
        description: assignment.testCase.description ?? undefined,
        plan: assignment.plan?.prompt ?? "",
        generation:
            generation != null
                ? {
                      id: generation.id,
                      status: generation.status,
                      verdict: generation.generationReview?.verdict ?? undefined,
                      reviewReasoning: generation.generationReview?.reasoning ?? undefined,
                  }
                : undefined,
        run:
            run != null
                ? {
                      id: run.id,
                      status: run.status,
                      verdict: run.runReview?.verdict ?? undefined,
                      reviewReasoning: run.runReview?.reasoning ?? undefined,
                  }
                : undefined,
        quarantine:
            assignment.quarantineIssue != null
                ? {
                      issueId: assignment.quarantineIssue.id,
                      reason: assignment.quarantineIssue.kind,
                      bugId: assignment.quarantineIssue.bugId ?? undefined,
                  }
                : undefined,
    };
}

function pickLatest<T>(rows: T[], keyOf: (row: T) => string, timeOf: (row: T) => number): Map<string, T> {
    const latest = new Map<string, T>();
    for (const row of rows) {
        const key = keyOf(row);
        const existing = latest.get(key);
        if (existing == null || timeOf(row) > timeOf(existing)) latest.set(key, row);
    }
    return latest;
}
