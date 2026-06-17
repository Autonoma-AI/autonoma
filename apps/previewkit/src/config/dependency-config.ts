import { db } from "@autonoma/db";
import type { GitProvider } from "../git-provider/git-provider";
import { type Logger, logger as rootLogger } from "../logger";
import { loadPreviewConfig } from "./file";
import { type ActiveConfig, loadActiveConfig } from "./revisions";
import type { PreviewConfig, RepoDependency } from "./schema";

export interface ResolvedDependencyConfig {
    config: PreviewConfig;
    /** The branch the dependency's tarball should be fetched at. */
    branch: string;
    usedFallback: boolean;
    source: "revision" | "file";
    revisionId?: string;
}

/**
 * Resolves a multirepo dependency's preview config, preferring the dependency
 * repo's Application active DB revision (dashboard-authored config) over its
 * repo-committed `.preview.yaml`.
 *
 * Resolution order:
 * 1. Map `dep.repo` -> GitHub repo id -> the org's Application row, and load its
 *    active config revision. When one exists, the clone branch is resolved
 *    independently (target branch, then `fallback_branch`).
 * 2. Fall back to the `.preview.yaml` path with its existing semantics: the file's
 *    presence on the target branch (then the fallback branch) signals both that
 *    the dependency opted in and which branch to clone.
 *
 * Returns undefined when neither source yields a config (the dependency is
 * skipped, matching the historical opt-out behavior). GitHub lookup failures
 * degrade to the file path so a flaky API call can never regress existing
 * `.preview.yaml`-based dependencies.
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
    if (revision != null) {
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
        });
        return {
            config: revision.config,
            branch: branch.name,
            usedFallback: branch.usedFallback,
            source: "revision",
            revisionId: revision.revisionId,
        };
    }

    // File path keeps the historical semantics: `.preview.yaml` presence on a
    // branch signals both opt-in and which branch to clone.
    let config = await loadPreviewConfig(provider, dep.repo, targetBranch);
    let branch = targetBranch;
    let usedFallback = false;

    if (config == null && targetBranch !== dep.fallback_branch) {
        config = await loadPreviewConfig(provider, dep.repo, dep.fallback_branch);
        branch = dep.fallback_branch;
        usedFallback = true;
    }

    if (config == null) {
        logger.warn("No active config revision and no .preview.yaml found for dependency repo", {
            name: dep.name,
            repo: dep.repo,
            targetBranch,
            fallbackBranch: dep.fallback_branch,
        });
        return undefined;
    }

    logger.info("Dependency config resolved from .preview.yaml", { name: dep.name, repo: dep.repo, branch });
    return { config, branch, usedFallback, source: "file" };
}

/**
 * Maps the dependency repo's full name onto the org's Application row and loads
 * its active config revision. Returns undefined whenever any link in the chain
 * is missing (repo not visible, no Application, no active revision) - the caller
 * then falls back to the `.preview.yaml` path.
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
        logger.warn("Failed to resolve dependency repo on GitHub, falling back to .preview.yaml", {
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
        logger.info("Dependency repo has no Application in this org, falling back to .preview.yaml", {
            name: dep.name,
            repo: dep.repo,
            githubRepositoryId: repoId,
        });
        return undefined;
    }

    return await loadActiveConfig(application.id);
}

/**
 * Picks the branch to clone for a revision-sourced dependency: the resolved
 * target branch when it exists, otherwise the configured fallback branch.
 * A failed branch lookup (404 or transient) counts as "branch missing" - the
 * error is logged so transient failures remain diagnosable.
 */
async function resolveCloneBranch(
    provider: GitProvider,
    dep: RepoDependency,
    targetBranch: string,
    logger: Logger,
): Promise<{ name: string; usedFallback: boolean } | undefined> {
    try {
        await provider.getBranchHead(dep.repo, targetBranch);
        return { name: targetBranch, usedFallback: false };
    } catch (err) {
        logger.debug("Target branch not found for dependency repo, trying fallback", {
            repo: dep.repo,
            targetBranch,
            err,
        });
    }

    if (targetBranch === dep.fallback_branch) return undefined;

    try {
        await provider.getBranchHead(dep.repo, dep.fallback_branch);
        return { name: dep.fallback_branch, usedFallback: true };
    } catch (err) {
        logger.warn("Fallback branch not found for dependency repo", {
            repo: dep.repo,
            fallbackBranch: dep.fallback_branch,
            err,
        });
        return undefined;
    }
}
