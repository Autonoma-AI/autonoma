import type { GenerationStatus, Prisma, PrismaClient } from "@autonoma/db";

/** One execution of a test's plan on one snapshot. */
export interface SuiteRun {
    runId: string;
    testCaseId: string;
    status: GenerationStatus;
    startedAt: Date;
}

/**
 * Where each of a snapshot's tests stands: its most recent run, for every test one was started for.
 *
 * A test can be run more than once on one snapshot - a re-run after the plan was revised, a self-heal's second
 * attempt - and what a reader wants is the current state rather than the history, so the store answers that
 * instead of handing out the raw list for each caller to reduce its own way.
 */
export async function readLatestRunPerTest(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<SuiteRun[]> {
    const runs = await db.testGeneration.findMany({
        where: { snapshotId },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, createdAt: true, testPlan: { select: { testCaseId: true } } },
    });

    const latestByTestCaseId = new Map<string, SuiteRun>();
    for (const run of runs) {
        latestByTestCaseId.set(run.testPlan.testCaseId, {
            runId: run.id,
            testCaseId: run.testPlan.testCaseId,
            status: run.status,
            startedAt: run.createdAt,
        });
    }
    return Array.from(latestByTestCaseId.values());
}
