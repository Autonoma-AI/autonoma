export interface BranchForkPoint {
    baseSnapshotId?: string;
    activeSnapshotPrevSnapshotId?: string;
}

/**
 * The one rule turning a branch's pointers into its fork point: the snapshot its suite diverged from.
 *
 * `baseSnapshotId` is pinned the first time a branch forks from another branch's snapshot and never re-pinned,
 * so it is the answer whenever it exists. Branches that predate the pin fall back to what their active snapshot
 * was opened from, which is the same divergence point for a branch that has only ever moved forward.
 *
 * Absent when the branch has neither - it has no lineage to compare against, and callers degrade rather than
 * guess (a PR diff view shows nothing; a merge falls back to its non-merge path).
 */
export function deriveForkPointSnapshotId(branch: BranchForkPoint): string | undefined {
    return branch.baseSnapshotId ?? branch.activeSnapshotPrevSnapshotId;
}
