import { tallyExecutedTests, type SnapshotExecutedTest } from "@autonoma/checkpoint";
import type { Logger } from "@autonoma/logger";
import type { ReportTestStatus, SnapshotReportResults, SnapshotReportTestResult } from "@autonoma/types";

// The checkpoint report header ("X tests run, Y passed, Z failed"), the executed-tests list
// rendered below it, the checkpoint history rail, and the cumulative PR card must all agree.
// They diverged because this block counted raw `Run` rows directly (ignoring the refinement
// loop and counting superseded runs), while every other surface derives from
// `listExecutedTestsForSnapshot`. We now build the results block from that same canonical
// source so every surface reports the same numbers.
export function buildResultsBlock(executedTests: SnapshotExecutedTest[], parentLogger: Logger): SnapshotReportResults {
    const logger = parentLogger.child({ name: "buildResultsBlock" });

    const tests: SnapshotReportTestResult[] = executedTests.map((test) => ({
        testCaseId: test.testCase.id,
        name: test.testCase.name,
        slug: test.testCase.slug,
        status: reportStatusForExecutedTest(test),
    }));

    // Terminal outcomes (passed / failed / setup_failed) come from the shared
    // classifier so the report header agrees with the panel and health counts.
    // The pending vs running split is a presentation concern over the remaining
    // in-flight tests, so it stays local to the per-test report status.
    const tally = tallyExecutedTests(executedTests);
    const { pending, running } = countInFlight(tests);

    logger.info("Built results block", {
        extra: { executedTests: executedTests.length },
    });

    return {
        passed: tally.passing,
        failed: tally.failing,
        setupFailed: tally.setupFailed,
        pending,
        running,
        total: tests.length,
        tests,
    };
}

function reportStatusForExecutedTest(test: SnapshotExecutedTest): ReportTestStatus {
    if (test.finalOutcome === "passed") return "passed";
    if (test.finalOutcome === "failed") return "failed";
    if (test.finalOutcome === "setup_failed") return "setup_failed";
    if (test.status === "running" || test.status === "queued") return "running";
    return "pending";
}

function countInFlight(tests: SnapshotReportTestResult[]) {
    let running = 0;
    let pending = 0;

    for (const test of tests) {
        if (test.status === "running") running += 1;
        else if (test.status === "pending") pending += 1;
    }

    return { pending, running };
}
