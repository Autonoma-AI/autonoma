import type { GitProvider } from "../git-provider/git-provider";
import { type Logger, logger as rootLogger } from "../logger";
import type { PreviewConfig, RepoDependency } from "./schema";

export interface ResolvedDependencyConfig {
    config: PreviewConfig;
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
 * Resolves a multirepo dependency for a deploy. The dependency's config is owned
 * by the primary app's revision (passed in as `dependencyConfig`) - dependency
 * repos are not separate Applications. This only resolves the clone branch (the
 * target branch from the convention, then `fallback_branch`); the repo is cloned
 * for source.
 *
 * Returns undefined when the primary revision has no config for this repo (it is
 * skipped) or when neither the target nor the fallback branch resolves.
 */
export async function resolveDependencyConfig(
    provider: GitProvider,
    dep: RepoDependency,
    targetBranch: string,
    dependencyConfig: PreviewConfig | undefined,
): Promise<ResolvedDependencyConfig | undefined> {
    const logger = rootLogger.child({ name: "resolveDependencyConfig" });
    logger.info("Resolving dependency config", { name: dep.name, repo: dep.repo, targetBranch });

    if (dependencyConfig == null) {
        logger.warn("Primary revision has no config for dependency repo; skipping", {
            name: dep.name,
            repo: dep.repo,
            targetBranch,
        });
        return undefined;
    }

    const branch = await resolveCloneBranch(provider, dep, targetBranch, logger);
    if (branch == null) {
        logger.warn("Dependency repo has a config but no resolvable branch, skipping", {
            name: dep.name,
            repo: dep.repo,
            targetBranch,
            fallbackBranch: dep.fallback_branch,
        });
        return undefined;
    }

    logger.info("Dependency config resolved from primary revision", {
        name: dep.name,
        repo: dep.repo,
        branch: branch.name,
        sha: branch.sha,
    });
    return {
        config: dependencyConfig,
        branch: branch.name,
        sha: branch.sha,
        usedFallback: branch.usedFallback,
    };
}

/**
 * Picks the branch to clone for a revision-sourced dependency and resolves it to
 * a concrete commit: the target branch when it exists, otherwise the configured
 * fallback branch. `getBranchHead` returns the branch's head SHA, which is
 * carried through as the recorded deploy provenance. A failed branch lookup (404
 * or transient) counts as "branch missing" - the error is logged so transient
 * failures remain diagnosable.
 */
async function resolveCloneBranch(
    provider: GitProvider,
    dep: RepoDependency,
    targetBranch: string,
    logger: Logger,
): Promise<{ name: string; sha: string; usedFallback: boolean } | undefined> {
    try {
        const sha = await provider.getBranchHead(dep.repo, targetBranch);
        return { name: targetBranch, sha, usedFallback: false };
    } catch (err) {
        logger.debug("Target branch not found for dependency repo, trying fallback", {
            repo: dep.repo,
            targetBranch,
            err,
        });
    }

    if (targetBranch === dep.fallback_branch) return undefined;

    try {
        const sha = await provider.getBranchHead(dep.repo, dep.fallback_branch);
        return { name: dep.fallback_branch, sha, usedFallback: true };
    } catch (err) {
        logger.warn("Fallback branch not found for dependency repo", {
            repo: dep.repo,
            fallbackBranch: dep.fallback_branch,
            err,
        });
        return undefined;
    }
}
