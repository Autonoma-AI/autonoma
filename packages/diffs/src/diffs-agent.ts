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
 * handled outside the agent (unilateral_update / new_test) are dispatched to
 * replay directly with `merge_plan_imported` and are intentionally not
 * included in `existingTests` for the agent-visible list.
 */
export interface PreClassifiedConflictInfo {
    slug: string;
    testName: string;
    versions: PreClassifiedConflictVersion[];
    involvedPrNumbers: number[];
}
