import type { AnalysisLifecycleSummary } from "@autonoma/analysis";
import type { SnapshotHealth, SnapshotHealthResult } from "@autonoma/test-suite";
import {
    type CheckpointExecutionState,
    type CheckpointPresentationSummary,
    type CheckpointTone,
    PIPELINE_LABEL,
    type RunPlaneSummary,
} from "@autonoma/types";

/** `not_started` is `unknown`, never `healthy`: a run that confirmed nothing has not vouched for the app. */
const HEALTH_BY_EXECUTION_STATE: Record<CheckpointExecutionState, SnapshotHealth> = {
    passed: "healthy",
    failed: "critical",
    pipeline_failed: "critical",
    running: "running",
    not_started: "unknown",
    stale: "unknown",
    unknown: "unknown",
};

export interface CheckpointPresentation {
    summary: CheckpointPresentationSummary;
    health: SnapshotHealth;
    settled: boolean;
}

export interface PresentCheckpointInput {
    lifecycle: AnalysisLifecycleSummary | undefined;
    /** Read only for `totalTests`, the "of N tests" denominator. */
    healthResult: SnapshotHealthResult | undefined;
    suiteChangeCount?: number;
}

/**
 * How one snapshot reads on the rail: its badge, its counts and the health signal beside them.
 *
 * `undefined` for a snapshot the pipeline never analyzed: there is nothing to say about a run that never happened,
 * and a fabricated summary reads as a real verdict.
 *
 * Scoped to THIS run, because the rail is a history: a row says what that commit's tests found, not what the PR
 * currently reads as. The PR-level answer is `BranchLedger.verdict()`.
 */
export function presentCheckpoint(input: PresentCheckpointInput): CheckpointPresentation | undefined {
    const { lifecycle } = input;
    if (lifecycle == null) return undefined;

    const summary = buildCheckpointSummary({
        jobStatus: lifecycle.status,
        run: lifecycle.report,
        totalTests: input.healthResult?.counts.totalTests,
        suiteChangeCount: input.suiteChangeCount,
    });
    return {
        summary,
        health: HEALTH_BY_EXECUTION_STATE[summary.executionState],
        settled: lifecycle.report != null,
    };
}

interface CheckpointSummaryInput {
    jobStatus: AnalysisLifecycleSummary["status"];
    /** What the run found. Absent while it is still in flight, or when it failed before settling. */
    run: RunPlaneSummary | undefined;
    totalTests?: number;
    suiteChangeCount?: number;
}

function buildCheckpointSummary(input: CheckpointSummaryInput): CheckpointPresentationSummary {
    const run = input.run;
    const investigated = run?.testCount ?? 0;
    const totalTests = input.totalTests ?? investigated;
    const suiteChangeCount = input.suiteChangeCount ?? 0;

    const { tone, label, reason, executionState } = derivePresentation(input.jobStatus, run);

    return {
        tone,
        label,
        reason,
        executionState,
        testCounts: {
            assigned: totalTests,
            run: investigated,
            passed: run?.passedCount ?? 0,
            // Bugs and coverage gaps ride the `analysis` block below; these three buckets are the suite's, not ours.
            failed: 0,
            setupFailed: 0,
            running: 0,
            notRun: Math.max(totalTests - investigated, 0),
        },
        suiteChangeCount,
        analysis: {
            jobStatus: input.jobStatus,
            bugCount: run?.bugCount ?? 0,
            passedCount: run?.passedCount ?? 0,
            coverageCount: run?.coverage.total ?? 0,
        },
    };
}

function derivePresentation(
    jobStatus: AnalysisLifecycleSummary["status"],
    run: RunPlaneSummary | undefined,
): { tone: CheckpointTone; label: string; reason?: string; executionState: CheckpointExecutionState } {
    if (jobStatus === "failed") {
        return {
            tone: "critical",
            label: PIPELINE_LABEL.checkpointFailed,
            reason: "pipeline error",
            executionState: "pipeline_failed",
        };
    }

    if (jobStatus === "running" || run == null) {
        return { tone: "neutral", label: PIPELINE_LABEL.analyzing, executionState: "running" };
    }

    const state = run.state;

    if (state === "bug_found") {
        return { tone: "critical", label: `${run.bugCount} ${plural(run.bugCount, "bug")}`, executionState: "failed" };
    }

    // A decision, not a run that fell short - so `passed` and green, with the label carrying which green it is.
    if (state === "no_tests_needed") {
        return { tone: "success", label: "No tests needed", executionState: "passed" };
    }

    // A coverage gap means the change was not fully confirmed. Stated as a RATIO rather than "Not confirmed",
    // because six checks confirmed out of seven does not read the same as none out of seven, and one amber word
    // collapses them into the same alarm. `neutral`, not `warning`: only a bug is raised as a problem, matching the
    // PR comment and the PR page. `not_started` still, so the derived health reads `unknown` rather than `healthy` -
    // the app was not fully checked this run, whatever the ratio says.
    if (state === "not_confirmed") {
        const checked = run.passedCount + run.coverage.total;
        return {
            tone: "neutral",
            label: `${run.passedCount}/${checked} verified`,
            reason: `${run.coverage.total} couldn't complete`,
            executionState: "not_started",
        };
    }

    return { tone: "success", label: "Passing", executionState: "passed" };
}

function plural(count: number, word: string): string {
    return count === 1 ? word : `${word}s`;
}
