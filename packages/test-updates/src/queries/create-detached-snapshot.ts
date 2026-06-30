import type { PrismaClient, TriggerSource } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { ApplicationNotFoundError } from "../snapshot-draft";
import { createBranchSnapshot, resolveSnapshotSource } from "./create-branch-snapshot";

export interface CreateDetachedSnapshotParams {
    db: PrismaClient;
    branchId: string;
    /** Restricts the branch lookup to this organization, when provided. */
    organizationId?: string;
    source?: TriggerSource;
    headSha?: string;
    baseSha?: string;
}

/**
 * Creates a snapshot that clones the branch's baseline suite (pinned test case
 * assignments + scenario recipe versions) but is NOT wired to any branch pointer -
 * a detached fork. The investigation agent runs on such a snapshot so its shadow
 * generations never land on the branch's pending/active snapshot (which the diffs
 * refinement loop reads), and so its work can be compared as an independent A/B arm.
 *
 * Forks from the same source the diffs snapshot does (the branch's active snapshot,
 * else main's). Returns `undefined` when there is no baseline suite to fork from -
 * there is then nothing to investigate, so the caller should not run the workflow.
 */
export async function createDetachedSnapshot({
    db,
    branchId,
    organizationId: filterOrgId,
    source,
    headSha,
    baseSha,
}: CreateDetachedSnapshotParams): Promise<{ snapshotId: string } | undefined> {
    const logger = rootLogger.child({ name: "createDetachedSnapshot", branchId });
    logger.info("Creating detached snapshot");

    const branch = await db.branch.findUnique({
        where: { id: branchId, organizationId: filterOrgId },
        select: {
            activeSnapshotId: true,
            application: {
                select: {
                    mainBranchId: true,
                    mainBranch: { select: { activeSnapshotId: true } },
                },
            },
        },
    });

    if (branch == null) throw new ApplicationNotFoundError(branchId);

    const { sourceSnapshotId, sourceKind } = resolveSnapshotSource(branchId, branch);
    if (sourceSnapshotId == null) {
        logger.info("No baseline suite to fork from; skipping detached snapshot", { extra: { sourceKind } });
        return undefined;
    }

    const { snapshotId } = await db.$transaction((tx) =>
        createBranchSnapshot({ tx, branchId, branch, source, headSha, baseSha, logger }),
    );

    logger.info("Detached snapshot created", { snapshot: { snapshotId } });
    return { snapshotId };
}
