import type { GitProvider } from "../git-provider/git-provider";
import { type Logger, logger as rootLogger } from "../logger";

export interface DependencyCheckout {
    /** The branch the dependency's tarball should be fetched at. */
    branch: string;
    /**
     * The concrete commit SHA `branch` resolved to at deploy time. The tarball
     * is fetched at this SHA (not the branch name) so the deployed code matches
     * the recorded provenance even if the branch moves mid-deploy.
     */
    sha: string;
    usedFallback: boolean;
}

/**
 * Resolves which commit of a multirepo dependency repo a deploy checks out:
 * the target branch (from the branch convention) when it exists, otherwise the
 * repo's configured fallback branch. Returns undefined when neither resolves -
 * the caller records the repo's apps as skipped rather than failing the deploy.
 */
export async function resolveDependencyCheckout(
    provider: GitProvider,
    repo: string,
    targetBranch: string,
    fallbackBranch: string,
): Promise<DependencyCheckout | undefined> {
    const logger = rootLogger.child({ name: "resolveDependencyCheckout" });
    logger.info("Resolving dependency checkout", { repo, targetBranch, fallbackBranch });

    const branch = await resolveCloneBranch(provider, repo, targetBranch, fallbackBranch, logger);
    if (branch == null) {
        logger.warn("Dependency repo has no resolvable branch, skipping", { repo, targetBranch, fallbackBranch });
        return undefined;
    }

    logger.info("Dependency checkout resolved", { repo, branch: branch.name, sha: branch.sha });
    return { branch: branch.name, sha: branch.sha, usedFallback: branch.usedFallback };
}

/**
 * Picks the branch to clone for a dependency repo and resolves it to a concrete
 * commit: the target branch when it exists, otherwise the configured fallback
 * branch. `getBranchHead` returns the branch's head SHA, which is carried
 * through as the recorded deploy provenance. A failed branch lookup (404 or
 * transient) counts as "branch missing" - the error is logged so transient
 * failures remain diagnosable.
 */
async function resolveCloneBranch(
    provider: GitProvider,
    repo: string,
    targetBranch: string,
    fallbackBranch: string,
    logger: Logger,
): Promise<{ name: string; sha: string; usedFallback: boolean } | undefined> {
    try {
        const sha = await provider.getBranchHead(repo, targetBranch);
        return { name: targetBranch, sha, usedFallback: false };
    } catch (err) {
        logger.debug("Target branch not found for dependency repo, trying fallback", { repo, targetBranch, err });
    }

    if (targetBranch === fallbackBranch) return undefined;

    try {
        const sha = await provider.getBranchHead(repo, fallbackBranch);
        return { name: fallbackBranch, sha, usedFallback: true };
    } catch (err) {
        logger.warn("Fallback branch not found for dependency repo", { repo, fallbackBranch, err });
        return undefined;
    }
}
