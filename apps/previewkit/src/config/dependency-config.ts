import { db } from "@autonoma/db";
import type { GitProvider } from "../git-provider/git-provider";
import { type Logger, logger as rootLogger } from "../logger";
import { type ActiveConfig, loadActiveConfig } from "./revisions";
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
    revisionId: string;
}

/**
 * Resolves a multirepo dependency's preview config from the dependency repo's
 * Application active DB config revision (dashboard-authored config).
 *
 * Maps `dep.repo` -> GitHub repo id -> the org's Application row, and loads its
 * active config revision. The clone branch is resolved independently (the
 * target branch, then `fallback_branch`).
 *
 * Returns undefined when the dependency has no active config revision (it is
 * skipped, matching the historical opt-out behavior) or when neither the target
 * nor the fallback branch resolves.
 */
export async function resolveDependencyConfig(
    provider: GitProvider,
    organizationId: string,
    dep: RepoDependency,
    targetBranch: string,
): Promise<ResolvedDependencyConfig | undefined> {
    const logger = rootLogger.child({ name: "resolveDependencyConfig" });
    logger.info("Resolving dependency config", { name: dep.name, repo: dep.repo, targetBranch, organizationId });

    const revision = await loadDependencyRevision(provider, organizationId, dep, logger);
    if (revision == null) {
        logger.warn("No active config revision for dependency repo; skipping", {
            name: dep.name,
            repo: dep.repo,
            targetBranch,
        });
        return undefined;
    }

    const branch = await resolveCloneBranch(provider, dep, targetBranch, logger);
    if (branch == null) {
        logger.warn("Dependency repo has an active config revision but no resolvable branch, skipping", {
            name: dep.name,
            repo: dep.repo,
            targetBranch,
            fallbackBranch: dep.fallback_branch,
        });
        return undefined;
    }

    logger.info("Dependency config resolved from DB revision", {
        name: dep.name,
        repo: dep.repo,
        revisionId: revision.revisionId,
        branch: branch.name,
        sha: branch.sha,
    });
    return {
        config: revision.config,
        branch: branch.name,
        sha: branch.sha,
        usedFallback: branch.usedFallback,
        revisionId: revision.revisionId,
    };
}

/**
 * Maps the dependency repo's full name onto the org's Application row and loads
 * its active config revision. Returns undefined whenever any link in the chain
 * is missing (repo not visible, no Application, no active revision) - the caller
 * then skips the dependency.
 */
async function loadDependencyRevision(
    provider: GitProvider,
    organizationId: string,
    dep: RepoDependency,
    logger: Logger,
): Promise<ActiveConfig | undefined> {
    let repoId: number | undefined;
    try {
        const repo = await provider.getRepositoryByFullName(dep.repo);
        repoId = repo?.id;
    } catch (err) {
        logger.warn("Failed to resolve dependency repo on GitHub; skipping", {
            name: dep.name,
            repo: dep.repo,
            err,
        });
        return undefined;
    }
    if (repoId == null) return undefined;

    const application = await db.application.findUnique({
        where: { organizationId_githubRepositoryId: { organizationId, githubRepositoryId: repoId } },
        select: { id: true },
    });
    if (application == null) {
        logger.info("Dependency repo has no Application in this org; skipping", {
            name: dep.name,
            repo: dep.repo,
            githubRepositoryId: repoId,
        });
        return undefined;
    }

    return await loadActiveConfig(application.id);
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
