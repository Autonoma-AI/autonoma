import type { CheckpointPresentationSummary } from "@autonoma/types";
import { unresolvedBucketLabel } from "@autonoma/types";

// A completed diffs job that executed nothing is a final, healthy verdict: the analysis concluded the
// change touches no tests. Without this the comment would read as an in-progress state forever.
const NO_TESTS_AFFECTED_HEADLINE =
    "Autonoma analyzed this change - no selected tests are affected, so there was nothing to run.";
const HEALTHY_HEADLINE = "Autonoma found no issues in this PR.";
// A findings-clean twin whose primary checkpoint still reports failures/open bugs: we must not claim
// "no issues", so we defer to the checkpoint's own verdict.
const CHECKPOINT_UNRESOLVED_HEADLINE = "Autonoma could not complete every selected test in this PR.";

/** The test-stats shape a GitHub comment payload consumes (structurally an `AutonomaCommentStats`). */
export interface CommentTestStats {
    assigned: number;
    passed: number;
    failed: number;
    setupFailed: number;
    running: number;
    runningLabel: string;
}

/**
 * The comment stats line mirrors the in-app checkpoint row exactly, so the comment's counts and
 * vocabulary match the dashboard for the same snapshot.
 */
export function statsFromSummary(summary: CheckpointPresentationSummary): CommentTestStats {
    const tc = summary.testCounts;
    return {
        assigned: tc.assigned,
        passed: tc.passed,
        failed: tc.failed,
        setupFailed: tc.setupFailed,
        running: tc.running,
        runningLabel: unresolvedBucketLabel(summary.executionState),
    };
}

/** A completed diffs job that ran nothing: the change touches no selected tests. */
export function isNoTestsAffected(
    summary: CheckpointPresentationSummary | undefined,
    diffsJobStatus: string | undefined,
): boolean {
    return summary?.executionState === "not_started" && diffsJobStatus === "completed";
}

/**
 * The headline for a findings-clean comment (no client bugs or actionable findings). Reflects the
 * primary checkpoint honestly - never claims "no issues" while the checkpoint still reports failures
 * or open bugs (findings first, checkpoint second).
 */
export function healthyHeadlineFromSummary(
    summary: CheckpointPresentationSummary | undefined,
    diffsJobStatus: string | undefined,
): string {
    if (isNoTestsAffected(summary, diffsJobStatus)) return NO_TESTS_AFFECTED_HEADLINE;
    if (summary == null) return HEALTHY_HEADLINE;

    const checkpointReportsTrouble =
        summary.openBugCount > 0 || summary.executionState === "failed" || summary.executionState === "pipeline_failed";
    if (checkpointReportsTrouble) return CHECKPOINT_UNRESOLVED_HEADLINE;

    return inProgressHeadline(summary) ?? HEALTHY_HEADLINE;
}

// The checkpoint's in-progress copy. Only the running/stale/not-started states need words here; the
// terminal states are handled by the caller (passed -> healthy, failed/bugs -> checkpoint trouble).
function inProgressHeadline(summary: CheckpointPresentationSummary): string | undefined {
    switch (summary.executionState) {
        case "not_started":
            return "Autonoma has not run the selected tests for this checkpoint yet.";
        case "running":
            return "Autonoma is running the selected tests for this PR.";
        case "stale":
            return "These results are from an earlier commit - a rerun is pending.";
        default:
            return undefined;
    }
}
