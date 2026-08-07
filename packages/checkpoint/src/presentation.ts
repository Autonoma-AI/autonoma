import {
    type AnalysisFindingBucketCounts,
    type CheckpointExecutionState,
    type CheckpointPresentationSummary,
    type CheckpointTone,
    PIPELINE_LABEL,
    deriveAnalysisVerdict,
} from "@autonoma/types";
import type { SnapshotHealthCounts } from "./health";

export interface BuildCheckpointSummaryInputs {
    snapshotStatus: string;
    counts: SnapshotHealthCounts;
    suiteChangeCount?: number;
}

const RUNNING_STATUS = "processing";

/**
 * Derives the presentation summary consumed by the PR list, PR detail header, checkpoint rows,
 * checkpoint history, the checkpoint report, and the GitHub PR comment from already-loaded counts.
 */
export function buildCheckpointSummary(inputs: BuildCheckpointSummaryInputs): CheckpointPresentationSummary {
    const { snapshotStatus, counts } = inputs;
    const suiteChangeCount = inputs.suiteChangeCount ?? 0;

    const executionState = deriveExecutionState(snapshotStatus, counts);
    const { tone, label, reason } = derivePresentation({ executionState, counts, suiteChangeCount });

    const run = counts.failing + counts.passing + counts.running + counts.setupFailed;
    return {
        tone,
        label,
        reason,
        executionState,
        testCounts: {
            assigned: counts.totalTests,
            run,
            passed: counts.passing,
            failed: counts.failing,
            setupFailed: counts.setupFailed,
            running: counts.running,
            notRun: counts.notAffected,
        },
        suiteChangeCount,
    };
}

/** The AnalysisJob lifecycle a checkpoint summary reads. Mirrors the `AnalysisJobStatus` db enum. */
export type AuthoritativeAnalysisJobStatus = "running" | "completed" | "failed";

export interface AuthoritativeCheckpointInputs {
    // The snapshot's AnalysisJob lifecycle.
    jobStatus: AuthoritativeAnalysisJobStatus;
    // Per-bucket tally of the AnalysisReport's findings; absent while the job is still running (no report yet).
    findingBuckets?: AnalysisFindingBucketCounts;
    // The PR's bug count driving the verdict: the branch's OPEN bug-kind issues, which the Reporter authored onto
    // AnalysisReport.clientBugCount. This, not the client_bug finding tally, is the authoritative red/green signal:
    // a bug carried across snapshots keeps the PR red even when no test re-ran it this snapshot. Defaults to the
    // finding buckets' bug count when absent.
    bugCount?: number;
    // Assigned test count for the metrics fallback; defaults to the investigated finding total when omitted.
    totalTests?: number;
    suiteChangeCount?: number;
}

/**
 * Derives the presentation summary for an AUTHORITATIVE snapshot (one the merged analysis pipeline ran) from its
 * AnalysisReport verdict + finding-category counts and its AnalysisJob lifecycle - never from the legacy
 * health/Bug model, which the pipeline does not populate (it files no Bug rows and its passed tests never land in
 * the legacy "passed" bucket). Coverage-plane findings never turn the checkpoint red or "awaiting triage".
 *
 * "No bugs" is not the same claim as "passing": a run only reads as green once it reached a conclusion, either
 * because a test confirmed the app or because Impact Analysis decided the change needed none.
 */
export function buildAuthoritativeCheckpointSummary(
    inputs: AuthoritativeCheckpointInputs,
): CheckpointPresentationSummary {
    const buckets = inputs.findingBuckets ?? { bug: 0, passed: 0, coverage: 0 };
    const investigated = buckets.bug + buckets.passed + buckets.coverage;
    const totalTests = inputs.totalTests ?? investigated;
    const suiteChangeCount = inputs.suiteChangeCount ?? 0;
    // The verdict-bearing bug count is issue-derived (open bug issues), not the client_bug finding tally, so a bug
    // carried across snapshots keeps the PR red even when no test re-ran it this snapshot.
    const bugCount = inputs.bugCount ?? buckets.bug;

    const { tone, label, reason, executionState } = deriveAuthoritativePresentation(inputs, buckets, bugCount);

    return {
        tone,
        label,
        reason,
        executionState,
        testCounts: {
            assigned: totalTests,
            run: investigated,
            passed: buckets.passed,
            // Bugs and coverage findings are surfaced via the `analysis` counts below, not the legacy buckets.
            failed: 0,
            setupFailed: 0,
            running: 0,
            notRun: Math.max(totalTests - investigated, 0),
        },
        suiteChangeCount,
        analysis: {
            jobStatus: inputs.jobStatus,
            bugCount,
            passedCount: buckets.passed,
            coverageCount: buckets.coverage,
        },
    };
}

function deriveAuthoritativePresentation(
    inputs: AuthoritativeCheckpointInputs,
    buckets: AnalysisFindingBucketCounts,
    bugCount: number,
): { tone: CheckpointTone; label: string; reason?: string; executionState: CheckpointExecutionState } {
    // The analysis pipeline itself failed.
    if (inputs.jobStatus === "failed") {
        return {
            tone: "critical",
            label: PIPELINE_LABEL.checkpointFailed,
            reason: "pipeline error",
            executionState: "pipeline_failed",
        };
    }

    // Still analyzing: the run is in flight (or has produced no report yet). A completed, still-current snapshot is
    // never "stale" here - staleness was a legacy-health artifact of passed tests sitting in the unresolved bucket.
    const hasReport = inputs.findingBuckets != null;
    if (inputs.jobStatus === "running" || !hasReport) {
        return { tone: "neutral", label: PIPELINE_LABEL.analyzing, executionState: "running" };
    }

    // Completed with a report. The shared verdict predicate decides green/amber/red, so this badge, the PR comment
    // and the merge-gate check-run cannot disagree. Only open bugs make it red; a coverage gap of any kind -
    // whether the client must fix it or it is on us - downgrades it to a non-green "Not confirmed".
    const investigated = buckets.bug + buckets.passed + buckets.coverage;
    const state = deriveAnalysisVerdict({
        bugCount,
        coverageGapCount: buckets.coverage,
        investigatedCount: investigated,
    });

    if (state === "bug_found") {
        return { tone: "critical", label: `${bugCount} ${plural(bugCount, "bug")}`, executionState: "failed" };
    }

    // Impact Analysis reviewed the diff and decided no test was needed. The run reached its conclusion, so the state
    // is `passed` rather than one that reads as pending, and the badge stays green alongside the PR comment and the
    // merge gate; the label carries which of the two green conclusions it was.
    if (state === "no_tests_needed") {
        return { tone: "success", label: "No tests needed", executionState: "passed" };
    }

    // A coverage gap means the change was not fully confirmed - whether nothing ran (blocked) or some tests passed
    // but others could not be assessed. `warning`, not `critical` (the PR is not proven broken), and `not_started`
    // so the derived health reads `unknown`, never `healthy` - the app was not fully checked this run.
    if (state === "not_confirmed") {
        const reason = buckets.passed === 0 ? `${buckets.coverage} blocked` : `${buckets.coverage} couldn't confirm`;
        return { tone: "warning", label: "Not confirmed", reason, executionState: "not_started" };
    }

    return { tone: "success", label: "Passing", executionState: "passed" };
}

function deriveExecutionState(snapshotStatus: string, counts: SnapshotHealthCounts): CheckpointExecutionState {
    if (snapshotStatus === "cancelled") return "unknown";
    if (snapshotStatus === "failed") return "pipeline_failed";
    if (counts.failing > 0 || counts.setupFailed > 0) return "failed";
    if (counts.running > 0) return snapshotStatus === RUNNING_STATUS ? "running" : "stale";
    if (snapshotStatus === RUNNING_STATUS) return "running";

    const run = counts.failing + counts.passing + counts.running + counts.setupFailed;
    if (run === 0) return "not_started";
    return "passed";
}

function derivePresentation({
    executionState,
    counts,
    suiteChangeCount,
}: {
    executionState: CheckpointExecutionState;
    counts: SnapshotHealthCounts;
    suiteChangeCount: number;
}): { tone: CheckpointTone; label: string; reason?: string } {
    // Pipeline failure.
    if (executionState === "pipeline_failed") {
        return { tone: "critical", label: PIPELINE_LABEL.checkpointFailed, reason: "pipeline error" };
    }

    if (executionState === "failed") {
        const label =
            counts.failing > 0
                ? `${counts.failing + counts.setupFailed} ${plural(counts.failing + counts.setupFailed, "failing")}`
                : `${counts.setupFailed} setup failed`;
        return { tone: "warning", label, reason: "awaiting triage" };
    }

    if (executionState === "running") return { tone: "neutral", label: "Running" };
    if (executionState === "stale") return { tone: "warning", label: "Stale results", reason: "rerun pending" };

    // No runs yet.
    if (executionState === "not_started") {
        const reason =
            suiteChangeCount > 0 ? `${suiteChangeCount} suite ${plural(suiteChangeCount, "change")}` : undefined;
        return { tone: "neutral", label: "No runs", reason };
    }

    if (executionState === "passed") return { tone: "success", label: "Passing" };
    return { tone: "neutral", label: "Unknown" };
}

function plural(count: number, word: string): string {
    if (count === 1) return word;
    if (word === "failing") return word;
    return `${word}s`;
}
