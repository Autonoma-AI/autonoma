import type {
    CheckpointExecutionState,
    CheckpointFailingByKind,
    CheckpointPresentationSummary,
    CheckpointTone,
} from "@autonoma/types";
import type { SnapshotHealthCounts } from "./snapshot-health";

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

/**
 * Derives the presentation summary consumed by the PR list, PR detail header, checkpoint rows,
 * checkpoint history, and the checkpoint report from already-loaded counts.
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
