import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";

export interface UpsertPrBranchParams {
    db: PrismaClient;
    applicationId: string;
    organizationId: string;
    prNumber: number;
    /** Head ref to store as the branch name; refreshed on an existing branch. */
    name: string;
}

/**
 * Finds or creates the PR (feature) branch for `(applicationId, prNumber)`, the stable key a PR maps to.
 *
 * Called from both the diffs-trigger path (lazy, at diff time) and the previewkit-deploy path (eager, when a
 * preview environment is provisioned, before any diff runs), so it takes a `db` handle rather than living on a
 * constructed service. An existing branch has its `name` refreshed to the current head ref; a new branch is
 * created with no snapshots. The base snapshot is intentionally NOT pinned here - it is pinned when the branch's
 * first snapshot is created (see `SnapshotDraft.start`).
 */
export async function upsertPrBranch({
    db,
    applicationId,
    organizationId,
    prNumber,
    name,
}: UpsertPrBranchParams): Promise<{ id: string; activeSnapshotHeadSha?: string }> {
    const logger = rootLogger.child({ name: "upsertPrBranch" });
    logger.info("Upserting PR branch", { applicationId, prNumber, extra: { name } });

    return db.$transaction(async (tx) => {
        const existing = await tx.featureBranchInfo.findUnique({
            where: { applicationId_prNumber: { applicationId, prNumber } },
            select: {
                branch: {
                    select: {
                        id: true,
                        activeSnapshot: { select: { headSha: true } },
                    },
                },
            },
        });

        if (existing != null) {
            await tx.branch.update({ where: { id: existing.branch.id }, data: { name } });
            return {
                id: existing.branch.id,
                activeSnapshotHeadSha: existing.branch.activeSnapshot?.headSha ?? undefined,
            };
        }

        const created = await tx.branch.create({
            data: {
                name,
                applicationId,
                organizationId,
                prInfo: { create: { applicationId, prNumber } },
            },
            select: {
                id: true,
                activeSnapshot: { select: { headSha: true } },
            },
        });
        logger.info("Created new PR branch", { branchId: created.id, applicationId, prNumber });
        return { id: created.id, activeSnapshotHeadSha: created.activeSnapshot?.headSha ?? undefined };
    });
}
