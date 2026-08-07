import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { deriveForkPointSnapshotId } from "@autonoma/test-suite";

const logger = rootLogger.child({ name: "pinMergeSource" });

export interface PinnedMergeSource {
    snapshotId: string;
    branchId: string;
    branchName: string;
    prNumber: number;
    headSha: string;
    /** The source branch's fork point - the snapshot the merge classifier reads as the 3-way merge base. */
    baseSnapshotId: string | null;
}

export interface PinMergeSourceParams {
    applicationId: string;
    prNumber: number;
    sourceHeadSha: string;
}

/**
 * Resolve a merged PR to the source snapshot pinned at its head SHA: the branch registered for the PR number,
 * and its `activeSnapshot`.
 *
 * Relies on an upstream merge-blocking action that prevents a PR from merging while the feature branch has any
 * snapshot in `processing`. Under that invariant `branch.activeSnapshot.headSha === pr.headSha` at merge time,
 * so no snapshot scan by SHA is needed. The SHAs are still verified as a defensive sanity check; on mismatch the
 * caller falls back to the non-merge `code_change` path rather than risk importing the wrong plan.
 *
 * Returns `undefined` when there is no registered branch, no active snapshot, or the active snapshot's SHA
 * disagrees with the PR's head SHA.
 */
export async function pinMergeSource(
    db: PrismaClient,
    { applicationId, prNumber, sourceHeadSha }: PinMergeSourceParams,
): Promise<PinnedMergeSource | undefined> {
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
        logger.info("No feature branch registered for PR; merge falls back to normal path", {
            extra: { prNumber, sourceHeadSha },
        });
        return undefined;
    }

    const branch = info.branch;

    if (branch.activeSnapshot == null) {
        logger.info("Branch has no active snapshot; merge falls back to normal path", {
            branch: { branchId: branch.id },
            extra: { prNumber },
        });
        return undefined;
    }

    if (branch.activeSnapshot.headSha !== sourceHeadSha) {
        logger.warn("Active snapshot SHA does not match PR head SHA; merge-blocking invariant violated, falling back", {
            branch: { branchId: branch.id },
            extra: { prNumber, sourceHeadSha, activeSnapshotHeadSha: branch.activeSnapshot.headSha },
        });
        return undefined;
    }

    const baseSnapshotId =
        deriveForkPointSnapshotId({
            baseSnapshotId: branch.baseSnapshotId ?? undefined,
            activeSnapshotPrevSnapshotId: branch.activeSnapshot.prevSnapshotId ?? undefined,
        }) ?? null;
    if (baseSnapshotId == null) {
        logger.info("Source branch has no resolvable merge-base snapshot; using non-merge fallback", {
            branch: { branchId: branch.id },
            extra: { prNumber },
        });
    }

    logger.info("Pinned source snapshot for merge", {
        branch: { branchId: branch.id },
        extra: { prNumber, snapshotId: branch.activeSnapshot.id, baseSnapshotId },
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
