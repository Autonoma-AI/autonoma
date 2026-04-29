import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

export interface PinnedSourceSnapshot {
    snapshotId: string;
    branchId: string;
    branchName: string;
    prNumber: number;
    headSha: string;
    /**
     * The source branch's formal merge-base snapshot - the main snapshot the
     * branch was "based on". Resolved from `branch.baseSnapshotId` with a
     * fallback to `activeSnapshot.prevSnapshotId` (same contract as the PR
     * diff view in branches.service.ts). Used by the classifier to load the
     * 3-way merge-base assignments. Null when neither is available; callers
     * treat that as the non-merge fallback.
     */
    baseSnapshotId: string | null;
}

export interface FindMergeSourceSnapshotParams {
    db: PrismaClient;
    applicationId: string;
    prNumber: number;
    sourceHeadSha: string;
}

/**
 * Phase 1 source-snapshot resolution: look up the branch registered for the
 * given PR number and return its `activeSnapshot`.
 *
 * Relies on an upstream merge-blocking action that prevents a PR from merging
 * while the feature branch has any snapshot in `processing`. Under that
 * invariant, `branch.activeSnapshot.headSha === pr.headSha` at merge time, so
 * we don't need to scan snapshots by SHA. We still verify the SHAs match as a
 * defensive sanity check; on mismatch (invariant violated for any reason) we
 * fall back to the non-merge code_change path rather than risk importing the
 * wrong plan.
 *
 * Returns `null` when there's no registered branch, no active snapshot, or
 * the active snapshot's SHA disagrees with the PR's headSha.
 */
export async function findMergeSourceSnapshot({
    db,
    applicationId,
    prNumber,
    sourceHeadSha,
}: FindMergeSourceSnapshotParams): Promise<PinnedSourceSnapshot | null> {
    const logger = rootLogger.child({
        name: "findMergeSourceSnapshot",
        applicationId,
        prNumber,
        sourceHeadSha,
    });

    const info = await db.featureBranchInfo.findUnique({
        where: { applicationId_prNumber: { applicationId, prNumber } },
        select: {
            branch: {
                select: {
                    id: true,
                    name: true,
                    baseSnapshotId: true,
                    activeSnapshot: { select: { id: true, headSha: true, prevSnapshotId: true } },
                },
            },
        },
    });

    if (info == null) {
        logger.info("No feature branch registered for PR; merge falls back to normal path");
        return null;
    }

    const branch = info.branch;

    if (branch.activeSnapshot == null) {
        logger.info("Branch has no active snapshot; merge falls back to normal path", { branchId: branch.id });
        return null;
    }

    if (branch.activeSnapshot.headSha !== sourceHeadSha) {
        logger.warn("Active snapshot SHA does not match PR head SHA; merge-blocking invariant violated, falling back", {
            branchId: branch.id,
            activeSnapshotHeadSha: branch.activeSnapshot.headSha,
        });
        return null;
    }

    const baseSnapshotId = branch.baseSnapshotId ?? branch.activeSnapshot.prevSnapshotId ?? null;
    if (baseSnapshotId == null) {
        logger.info("Source branch has no resolvable merge-base snapshot; using non-merge fallback", {
            branchId: branch.id,
        });
    }

    logger.info("Pinned source snapshot for merge", {
        branchId: branch.id,
        snapshotId: branch.activeSnapshot.id,
        baseSnapshotId,
    });

    return {
        snapshotId: branch.activeSnapshot.id,
        branchId: branch.id,
        branchName: branch.name,
        prNumber,
        headSha: branch.activeSnapshot.headSha,
        baseSnapshotId,
    };
}
