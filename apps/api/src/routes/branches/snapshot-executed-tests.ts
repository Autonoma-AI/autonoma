import type { PrismaClient } from "@autonoma/db";

export async function listExecutedTestsForSnapshot(db: PrismaClient, snapshotId: string) {
    const [assignments, runs] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId, quarantineIssueId: null },
            select: {
                testCaseId: true,
                testCase: { select: { id: true, name: true, slug: true } },
            },
        }),
        db.run.findMany({
            where: { assignment: { snapshotId, quarantineIssueId: null } },
            select: {
                id: true,
                status: true,
                startedAt: true,
                completedAt: true,
                createdAt: true,
                assignment: { select: { testCaseId: true } },
                runReview: { select: { verdict: true, reasoning: true } },
            },
        }),
    ]);

    type RunRow = (typeof runs)[number];
    const latestRunByTestCaseId = new Map<string, RunRow>();

    for (const run of runs) {
        const testCaseId = run.assignment.testCaseId;
        const existing = latestRunByTestCaseId.get(testCaseId);
        if (existing == null || timeOf(run) > timeOf(existing)) {
            latestRunByTestCaseId.set(testCaseId, run);
        }
    }

    return assignments
        .flatMap((assignment) => {
            const run = latestRunByTestCaseId.get(assignment.testCaseId);
            if (run == null) return [];
            return [
                {
                    testCase: assignment.testCase,
                    runId: run.id,
                    status: run.status,
                    verdict: run.runReview?.verdict ?? null,
                    reviewReasoning: run.runReview?.reasoning ?? null,
                    startedAt: run.startedAt,
                    completedAt: run.completedAt,
                    createdAt: run.createdAt,
                    latestRunAt: run.startedAt ?? run.createdAt,
                },
            ];
        })
        .sort((left, right) => left.testCase.name.localeCompare(right.testCase.name));
}

function timeOf(run: { startedAt: Date | null; createdAt: Date }): number {
    return run.startedAt?.getTime() ?? run.createdAt.getTime();
}
