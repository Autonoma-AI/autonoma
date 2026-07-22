import type {
    AnalysisFindingBucketCounts,
    CheckpointExecutionState,
    CheckpointFailingByKind,
    CheckpointPresentationSummary,
    CheckpointTone,
} from "@autonoma/types";
import type { SnapshotHealthCounts } from "./health";

export interface BuildCheckpointSummaryInputs {
    snapshotStatus: string;
    counts: SnapshotHealthCounts;
    // Unique open application bugs (see countOpenBugsBySnapshot).
    openBugCount: number;
    // Raw application-issue occurrences; defaults to openBugCount when not separately known.
    issueOccurrenceCount?: number;
    // Engine-vs-app attribution of failing tests that carry a linked Issue.
    failingByKind: CheckpointFailingByKind;
    suiteChangeCount?: number;
}

const RUNNING_STATUS = "processing";
const ANALYZING_LABEL = "Analyzing";

/**
 * Derives the presentation summary consumed by the PR list, PR detail header, checkpoint rows,
 * checkpoint history, the checkpoint report, and the GitHub PR comment from already-loaded counts.
 */
export function buildCheckpointSummary(inputs: BuildCheckpointSummaryInputs): CheckpointPresentationSummary {
    const { snapshotStatus, counts, openBugCount, failingByKind } = inputs;
    const issueOccurrenceCount = inputs.issueOccurrenceCount ?? openBugCount;
    const suiteChangeCount = inputs.suiteChangeCount ?? 0;

    const executionState = deriveExecutionState(snapshotStatus, counts);
    const { tone, label, reason } = derivePresentation({
        executionState,
        counts,
        openBugCount,
        issueOccurrenceCount,
        suiteChangeCount,
    });

    const run = counts.failing + counts.passing + counts.running + counts.setupFailed;
    return {
        tone,
        label,
        reason,
        executionState,
        openBugCount,
        issueOccurrenceCount,
        testCounts: {
            assigned: counts.totalTests,
            run,
            passed: counts.passing,
            failed: counts.failing,
            setupFailed: counts.setupFailed,
            running: counts.running,
            notRun: counts.notAffected,
        },
        failingByKind: {
            engine: failingByKind.engine,
            app: failingByKind.app,
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
    // Assigned test count for the metrics fallback; defaults to the investigated finding total when omitted.
    totalTests?: number;
    suiteChangeCount?: number;
}

/**
 * Derives the presentation summary for an AUTHORITATIVE snapshot (one the merged analysis pipeline ran) from its
 * AnalysisReport verdict + finding-category counts and its AnalysisJob lifecycle - never from the legacy
 * health/Bug model, which the pipeline does not populate (it files no Bug rows and its passed tests never land in
 * the legacy "passed" bucket). Coverage-plane findings never turn the checkpoint red or "awaiting triage".
 */
export function buildAuthoritativeCheckpointSummary(
    inputs: AuthoritativeCheckpointInputs,
): CheckpointPresentationSummary {
    const buckets = inputs.findingBuckets ?? { bug: 0, passed: 0, coverage: 0 };
    const investigated = buckets.bug + buckets.passed + buckets.coverage;
    const totalTests = inputs.totalTests ?? investigated;
    const suiteChangeCount = inputs.suiteChangeCount ?? 0;

    const { tone, label, reason, executionState } = deriveAuthoritativePresentation(inputs, buckets);

    return {
        tone,
        label,
        reason,
        executionState,
        // Client bugs are the authoritative equivalent of open app bugs; there are no separate occurrences.
        openBugCount: buckets.bug,
        issueOccurrenceCount: buckets.bug,
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
        failingByKind: { engine: 0, app: 0 },
        suiteChangeCount,
        analysis: {
            jobStatus: inputs.jobStatus,
            bugCount: buckets.bug,
            passedCount: buckets.passed,
            coverageCount: buckets.coverage,
        },
    };
}

function deriveAuthoritativePresentation(
    inputs: AuthoritativeCheckpointInputs,
    buckets: AnalysisFindingBucketCounts,
): { tone: CheckpointTone; label: string; reason?: string; executionState: CheckpointExecutionState } {
    // The analysis pipeline itself failed.
    if (inputs.jobStatus === "failed") {
        return {
            tone: "critical",
            label: "Checkpoint failed",
            reason: "pipeline error",
            executionState: "pipeline_failed",
        };
    }

    // Still analyzing: the run is in flight (or has produced no report yet). A completed, still-current snapshot is
    // never "stale" here - staleness was a legacy-health artifact of passed tests sitting in the unresolved bucket.
    const hasReport = inputs.findingBuckets != null;
    if (inputs.jobStatus === "running" || !hasReport) {
        return { tone: "neutral", label: ANALYZING_LABEL, executionState: "running" };
    }

    // Completed with a report. Only client bugs count against the PR (the app-health plane); coverage findings are
    // non-blocking and never make the checkpoint red.
    if (buckets.bug > 0) {
        return { tone: "critical", label: `${buckets.bug} ${plural(buckets.bug, "bug")}`, executionState: "failed" };
    }

    const reason = buckets.coverage > 0 ? `${buckets.coverage} couldn't confirm` : undefined;
    return { tone: "success", label: "Passing", reason, executionState: "passed" };
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
    openBugCount,
    issueOccurrenceCount,
    suiteChangeCount,
}: {
    executionState: CheckpointExecutionState;
    counts: SnapshotHealthCounts;
    openBugCount: number;
    issueOccurrenceCount: number;
    suiteChangeCount: number;
}): { tone: CheckpointTone; label: string; reason?: string } {
    // Open app bugs.
    if (openBugCount > 0) {
        const reason = issueOccurrenceCount > openBugCount ? `${issueOccurrenceCount} occurrences` : undefined;
        return { tone: "critical", label: `${openBugCount} ${plural(openBugCount, "bug")}`, reason };
    }

    // Pipeline failure.
    if (executionState === "pipeline_failed") {
        return { tone: "critical", label: "Checkpoint failed", reason: "pipeline error" };
    }

    // A test failed (or couldn't run) but no open bug filed yet.
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
