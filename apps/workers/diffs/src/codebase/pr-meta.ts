import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import type { SnapshotContext } from "./snapshot-context";

export interface PrMeta {
    prNumber: number;
    prTitle?: string;
    prBody?: string;
}

/** PR number/title from the feature-branch record, body fetched from GitHub. Falls back gracefully for main. */
export async function resolvePrMeta(
    context: Pick<SnapshotContext, "branchId" | "githubRepositoryId" | "githubClient">,
): Promise<PrMeta> {
    const featureBranch = await db.featureBranchInfo.findUnique({
        where: { branchId: context.branchId },
        select: { prNumber: true, prTitle: true },
    });
    if (featureBranch == null) return { prNumber: 0 };

    const pullRequest = await context.githubClient
        .getPullRequest(context.githubRepositoryId, featureBranch.prNumber)
        .catch((error) => {
            rootLogger.warn("Could not fetch PR body from GitHub", {
                extra: { prNumber: featureBranch.prNumber },
                err: error,
            });
            return undefined;
        });

    return {
        prNumber: featureBranch.prNumber,
        prTitle: featureBranch.prTitle ?? undefined,
        prBody: pullRequest?.body ?? undefined,
    };
}
