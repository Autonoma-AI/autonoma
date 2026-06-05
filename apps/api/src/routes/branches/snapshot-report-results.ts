import type { PrismaClient } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import type { SnapshotReportResults, SnapshotReportTestResult, ReportTestStatus } from "@autonoma/types";

function runStatusToTestStatus(status: string): ReportTestStatus {
    if (status === "success") return "passed";
    if (status === "failed") return "failed";
    if (status === "running") return "running";
    return "pending";
}

export async function buildResultsBlock(
    db: PrismaClient,
    snapshotId: string,
    parentLogger: Logger,
): Promise<SnapshotReportResults> {
    const logger = parentLogger.child({ name: "buildResultsBlock" });

    const runs = await db.run.findMany({
        where: { assignment: { snapshotId } },
        select: {
            id: true,
            status: true,
            startedAt: true,
            completedAt: true,
            createdAt: true,
            assignment: {
                select: {
                    testCaseId: true,
                    testCase: { select: { name: true, slug: true } },
                },
            },
        },
    });

    type RunRow = (typeof runs)[number];
    const latestByTest = new Map<string, RunRow>();
    for (const run of runs) {
        const testId = run.assignment.testCaseId;
        const existing = latestByTest.get(testId);
        if (existing == null || timeOf(run) > timeOf(existing)) latestByTest.set(testId, run);
    }

    const tests: SnapshotReportTestResult[] = Array.from(latestByTest.values()).map((run) => ({
        testCaseId: run.assignment.testCaseId,
        name: run.assignment.testCase.name,
        slug: run.assignment.testCase.slug,
        status: runStatusToTestStatus(run.status),
        runId: run.id,
        durationMs:
            run.startedAt != null && run.completedAt != null
                ? run.completedAt.getTime() - run.startedAt.getTime()
                : undefined,
    }));

    const phaseDurationMs = runPhaseDuration(runs);
    logger.info("Built results block", {
        snapshotId,
        runs: runs.length,
        latestTests: tests.length,
        phaseDurationMs,
    });

    const counts = countResults(tests);

    return {
        durationMs: phaseDurationMs != null && phaseDurationMs > 0 ? phaseDurationMs : undefined,
        ...counts,
        tests,
    };
}

function countResults(tests: SnapshotReportTestResult[]) {
    let passed = 0;
    let failed = 0;
    let running = 0;
    let pending = 0;

    for (const test of tests) {
        if (test.status === "passed") passed += 1;
        else if (test.status === "failed") failed += 1;
        else if (test.status === "running") running += 1;
        else pending += 1;
    }

    return { passed, failed, pending, running, total: tests.length };
}

function timeOf(run: { startedAt: Date | null; createdAt: Date }): number {
    return run.startedAt?.getTime() ?? run.createdAt.getTime();
}

function runPhaseDuration(runs: Array<{ startedAt: Date | null; completedAt: Date | null }>): number | undefined {
    const startTimes = runs.map((r) => r.startedAt?.getTime()).filter((t): t is number => t != null);
    const endTimes = runs.map((r) => r.completedAt?.getTime()).filter((t): t is number => t != null);
    return startTimes.length > 0 && endTimes.length > 0 ? Math.max(...endTimes) - Math.min(...startTimes) : undefined;
}
