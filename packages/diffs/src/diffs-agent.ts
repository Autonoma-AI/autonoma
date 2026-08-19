/**
 * Shared data types for the diffs / resolution / healing pipeline. The actual
 * {@link DiffsAgent} class moved to `./agents/diffs/diffs-agent` as part of
 * the Agent-abstraction adoption. This file keeps the snapshot-level types
 * (test info, merge context, conflict info, etc.) that those agents and the
 * job code consume.
 */

export interface DiffAnalysis {
    affectedFiles: string[];
    summary: string;
}

export interface ExistingTestInfo {
    id: string;
    name: string;
    slug: string;
    description?: string;
    prompt: string;
}

export interface MergeContextInfo {
    prNumber: number;
    sourceBranchName: string;
    sourceSnapshotId: string;
    mergeCommitSha: string;
}

export interface PreClassifiedConflictVersion {
    /** Where this leg came from: main's current state, main's state when the source last synced, or one of the source branches. */
    role: "target-current" | "target-base" | "source";
    sourceName?: string;
    prNumber?: number;
    assignmentId: string;
    planId: string | null;
}

/**
 * A test that was deterministically classified as a merge conflict before the
 * agent ran. The agent receives these pre-marked as affected with
 * `affectedReason: "merge_conflict"` and only fills in the reasoning via the
 * `explain_merge_conflict` tool, using the provided legs for context. Tests
 * handled outside the agent (unilateral_update / new_test) have their winning
 * plan imported into the run's snapshot, which queues their generation, and are
 * intentionally not included in `existingTests` for the agent-visible list.
 */
export interface PreClassifiedConflictInfo {
    slug: string;
    testName: string;
    versions: PreClassifiedConflictVersion[];
    involvedPrNumbers: number[];
}

/**
 * A test a prior analysis run removed from the branch as `invalid_test` (its target feature/flow does not exist).
 * The test is gone from the current suite, so it is absent from {@link ExistingTestInfo} and the selector would
 * author it again; it is shown as prior work already thrown away so it is not re-created.
 */
export interface RemovedTestInfo {
    slug: string;
    name: string;
    /** Why a prior run judged it unexecutable. Absent when the removal recorded no note. */
    reason?: string;
}

/** One of the branch's recent Reporter report proses, given as prior context. Newest first. */
export interface PriorReportInfo {
    snapshotId: string;
    /** The report Markdown, truncated to the Reporter's own per-report bound. */
    report: string;
}

/**
 * An open bug-kind issue on the branch: a known problem area. Given to the selector only as context for where the
 * branch is already misbehaving, never as a verdict to reproduce - the covering tests of open issues are
 * re-verified deterministically elsewhere and the selector has no say in whether they run.
 */
export interface OpenIssueInfo {
    title: string;
    expectedBehavior?: string;
    actualBehavior: string;
    /** The slugs of the tests that currently cover this issue. */
    coveredSlugs: string[];
}

/**
 * A bounded, structured slice of the branch's analysis history, so the selector does not re-derive its choices as
 * if the branch had no past. Present only on the analysis selection path; absent on a brand-new branch with no
 * history at all, where selection is identical to a stateless run. Each member list is independently empty rather
 * than the whole slice being partial.
 */
export interface BranchHistory {
    removedTests: RemovedTestInfo[];
    priorReports: PriorReportInfo[];
    openIssues: OpenIssueInfo[];
}
