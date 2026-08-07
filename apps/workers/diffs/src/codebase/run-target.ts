import { db } from "@autonoma/db";
import type { GitHubInstallationClient } from "@autonoma/github";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalysisRunTarget } from "@autonoma/types";

interface ResolveRunTargetContext {
    branchId: string;
    githubRepositoryId: number;
    githubClient: GitHubInstallationClient;
}

/**
 * What this run is analyzing, derived from the snapshot's own branch: the PR it belongs to (number + title from
 * the feature-branch record, body fetched from GitHub), or the application's main branch.
 *
 * Every branch is created either as an application's main branch or as a PR's feature branch with its
 * `FeatureBranchInfo`, so the presence of that record is the discriminator. A branch that is neither is a data
 * anomaly worth a breadcrumb, not a third run kind.
 */
export async function resolveRunTarget(context: ResolveRunTargetContext): Promise<AnalysisRunTarget> {
    const branch = await db.branch.findUniqueOrThrow({
        where: { id: context.branchId },
        select: {
            name: true,
            prInfo: { select: { prNumber: true, prTitle: true } },
            application: { select: { mainBranchId: true } },
        },
    });

    const prInfo = branch.prInfo;
    if (prInfo == null) {
        if (branch.application.mainBranchId !== context.branchId) {
            rootLogger.warn("Branch is neither a PR branch nor its application's main branch", {
                branch: { branchId: context.branchId },
                extra: { branchName: branch.name },
            });
        }
        return { kind: "main_branch", branchName: branch.name };
    }

    const pullRequest = await context.githubClient
        .getPullRequest(context.githubRepositoryId, prInfo.prNumber)
        .catch((error) => {
            rootLogger.warn("Could not fetch PR body from GitHub", {
                extra: { prNumber: prInfo.prNumber },
                err: error,
            });
            return undefined;
        });

    return {
        kind: "pull_request",
        prNumber: prInfo.prNumber,
        prTitle: prInfo.prTitle ?? undefined,
        prBody: pullRequest?.body ?? undefined,
    };
}
