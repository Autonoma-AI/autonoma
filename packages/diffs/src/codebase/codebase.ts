import { join } from "node:path";
import type { GitHubInstallationClient } from "@autonoma/github";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { rimraf } from "rimraf";
import type { RepoCheckout, RepoManifest, UnavailableRepo } from "./manifest";

/** A repo to clone into a workspace, identified by its lowercased `owner/repo` name. */
export interface RepoCloneSpec {
    /** Lowercased `owner/repo` - the manifest name and the dependency-pin key. */
    name: string;
    /** Commit to check out. */
    commitSha: string;
    /** Base SHA to additionally fetch, enabling `git diff baseSha..commitSha`. Absent => read-only. */
    baseSha?: string;
}

export interface CloneWorkspaceSpec {
    primary: RepoCloneSpec;
    /** Dependency repos to clone beside the primary. A failed dependency clone degrades to `unavailable`, never throws. */
    dependencies: RepoCloneSpec[];
    /** Dependencies already known to be unavailable before cloning (e.g. an unresolvable key); listed in the manifest. */
    unavailable?: UnavailableRepo[];
}

/**
 * "The user's source tree at a specific commit", exposing its on-disk `root`.
 *
 * A `Codebase` is either a flat single-repo checkout - the historical default,
 * where `root` *is* the primary repo - or a multi-repo workspace, where `root`
 * is a parent directory holding the primary repo plus every dependency as named
 * sibling directories. The `bash` tool runs in `root` either way, so a
 * single-repo checkout behaves exactly as before, while a multi-repo workspace
 * lets the agent reach every repo by its sibling directory name.
 *
 * Get one via `Codebase.clone(...)` (single repo) or `Codebase.cloneWorkspace(...)`
 * (multi-repo), or construct directly (`new Codebase(path)`) when you already
 * have a populated single-repo tree (tests). Reuse across operations is the
 * default; call `dispose()` explicitly to remove the whole workspace.
 *
 * The research agents read the tree through the read-only `bash` tool, which
 * runs shell commands with `root` as its working directory - the `Codebase`
 * itself no longer offers file/search helpers. The agent is trusted internal
 * code reading the user's own repo, so traversal is not sandboxed: a command
 * that escapes `root` (absolute paths, symlinks) gets whatever the shell
 * returns, same as running it yourself.
 */
export class Codebase {
    private readonly logger: Logger;

    /** Every repo checked out in this workspace, primary first. */
    public readonly repos: RepoCheckout[];
    /** Dependencies that were expected but could not be checked out. */
    public readonly unavailableRepos: UnavailableRepo[];

    constructor(
        public readonly root: string,
        repos?: RepoCheckout[],
        unavailableRepos?: UnavailableRepo[],
    ) {
        this.repos = repos ?? [{ name: "primary", role: "primary", relPath: ".", dir: root, headSha: "" }];
        this.unavailableRepos = unavailableRepos ?? [];
        this.logger = rootLogger.child({ name: this.constructor.name, root });
    }

    /** The primary repo checkout (the application's own repo). */
    get primary(): RepoCheckout {
        const primary = this.repos.find((r) => r.role === "primary");
        if (primary == null) throw new Error("Codebase has no primary repo");
        return primary;
    }

    /**
     * Absolute path to the primary repo's clone. Equal to `root` for a flat
     * single-repo checkout; a sibling subdirectory in a multi-repo workspace. Use
     * this (not `root`) to run git against the primary repo directly - diff
     * reads, the merge flow - so the call works in either layout.
     */
    get primaryDir(): string {
        return this.primary.dir;
    }

    /**
     * The multi-repo manifest, or `undefined` for a plain single-repo checkout.
     * Present whenever the snapshot pinned at least one dependency - even if every
     * dependency clone failed, so the agent is still told which repos are missing.
     */
    dependencyManifest(): RepoManifest | undefined {
        const dependencies = this.repos.filter((r) => r.role === "dependency");
        if (dependencies.length === 0 && this.unavailableRepos.length === 0) return undefined;
        return { workspaceRoot: this.root, primary: this.primary, dependencies, unavailable: this.unavailableRepos };
    }

    /**
     * Shells out to `cloneRepository()` from `@autonoma/github` and returns a flat
     * single-repo `Codebase` rooted at `targetDir`. Clears `targetDir` first so a
     * dangling tree from a previous crashed run never interferes with the fresh
     * clone. Throws on any failure (removing the partially-populated `targetDir`
     * first). Caller owns the lifecycle - call `dispose()` when done.
     */
    static async clone(
        githubClient: GitHubInstallationClient,
        targetDir: string,
        opts: { repoName: string; commitSha: string; baseSha?: string },
    ): Promise<Codebase> {
        const logger = rootLogger.child({
            name: "Codebase.clone",
            repoName: opts.repoName,
            commitSha: opts.commitSha,
            targetDir,
        });
        logger.info("Clearing target directory before clone");
        await rimraf(targetDir);

        logger.info("Cloning repository for codebase access");
        try {
            await githubClient.cloneRepository({
                fullName: opts.repoName,
                headSha: opts.commitSha,
                baseSha: opts.baseSha,
                targetDir,
            });
        } catch (error) {
            await rimraf(targetDir).catch((cleanupError) => {
                logger.warn("Failed to clean up target directory after clone failure", {
                    extra: { error: cleanupError },
                });
            });
            throw error;
        }
        return new Codebase(targetDir);
    }

    /**
     * Clones a multi-repo workspace under `workspaceDir`: the primary repo plus
     * each dependency into a named sibling directory. The primary clone is
     * essential - it throws on failure (clearing the partial tree first). Each
     * dependency clone degrades on failure: the dependency is recorded as
     * {@link UnavailableRepo} and named in the manifest rather than aborting the
     * whole checkout, so a single unreachable backend repo never blocks a run.
     *
     * The returned `Codebase` has `root === workspaceDir` (the bash working
     * directory), so the agent reaches every repo by its sibling directory name.
     */
    static async cloneWorkspace(
        githubClient: GitHubInstallationClient,
        workspaceDir: string,
        spec: CloneWorkspaceSpec,
    ): Promise<Codebase> {
        const logger = rootLogger.child({
            name: "Codebase.cloneWorkspace",
            workspaceDir,
            primary: spec.primary.name,
            dependencyCount: spec.dependencies.length,
        });

        logger.info("Clearing workspace directory before clone");
        await rimraf(workspaceDir);

        const usedDirNames = new Set<string>();
        const primaryRelPath = uniqueDirName(spec.primary.name, usedDirNames);

        logger.info("Cloning primary repo into workspace", { extra: { relPath: primaryRelPath } });
        const primary = await cloneInto(githubClient, workspaceDir, "primary", spec.primary, primaryRelPath).catch(
            async (error) => {
                await rimraf(workspaceDir).catch((cleanupError) => {
                    logger.warn("Failed to clean up workspace after primary clone failure", {
                        extra: { error: cleanupError },
                    });
                });
                throw error;
            },
        );

        // Allocate every dependency's directory up front (sequential, since uniqueDirName mutates the used-name
        // set), then clone them concurrently: the clones are independent once their paths are fixed, and the
        // dependency count is bounded by the deploy's multirepo config, so a plain Promise.all is safe.
        const planned = spec.dependencies.map((dependency) => ({
            dependency,
            relPath: uniqueDirName(dependency.name, usedDirNames),
        }));
        const outcomes = await Promise.all(
            planned.map(({ dependency, relPath }) =>
                cloneDependency(githubClient, workspaceDir, dependency, relPath, logger),
            ),
        );

        // Rebuild in manifest order: successes keep their place among the repos, failures become unavailable.
        const repos: RepoCheckout[] = [primary];
        const unavailable: UnavailableRepo[] = [...(spec.unavailable ?? [])];
        for (const outcome of outcomes) {
            if ("repo" in outcome) repos.push(outcome.repo);
            else unavailable.push(outcome.unavailable);
        }

        logger.info("Workspace clone complete", {
            extra: { available: repos.length, unavailable: unavailable.length },
        });
        return new Codebase(workspaceDir, repos, unavailable);
    }

    /** Remove the on-disk workspace directory. Explicit, never auto-called. */
    async dispose(): Promise<void> {
        this.logger.info("Disposing codebase clone");
        await rimraf(this.root);
    }
}

/** Either the checked-out dependency or the reason it is unavailable. */
type DependencyOutcome = { repo: RepoCheckout } | { unavailable: UnavailableRepo };

/**
 * Clone one dependency, degrading its own failure to an {@link UnavailableRepo} (and cleaning up its partial
 * tree) rather than rejecting - so one unreachable backend repo never fails the whole workspace or its siblings.
 */
async function cloneDependency(
    githubClient: GitHubInstallationClient,
    workspaceDir: string,
    dependency: RepoCloneSpec,
    relPath: string,
    logger: Logger,
): Promise<DependencyOutcome> {
    try {
        logger.info("Cloning dependency repo into workspace", { extra: { name: dependency.name, relPath } });
        return { repo: await cloneInto(githubClient, workspaceDir, "dependency", dependency, relPath) };
    } catch (error) {
        logger.warn("Dependency clone failed, degrading to unavailable", {
            extra: { name: dependency.name, error },
        });
        await rimraf(join(workspaceDir, relPath)).catch((cleanupError) => {
            logger.warn("Failed to clean up partial dependency clone", {
                extra: { name: dependency.name, error: cleanupError },
            });
        });
        return { unavailable: { name: dependency.name, reason: "clone failed" } };
    }
}

/** Clone a single repo into `workspaceDir/<relPath>` and describe it as a {@link RepoCheckout}. */
async function cloneInto(
    githubClient: GitHubInstallationClient,
    workspaceDir: string,
    role: RepoCheckout["role"],
    spec: RepoCloneSpec,
    relPath: string,
): Promise<RepoCheckout> {
    const dir = join(workspaceDir, relPath);
    await githubClient.cloneRepository({
        fullName: spec.name,
        headSha: spec.commitSha,
        baseSha: spec.baseSha,
        targetDir: dir,
    });
    return { name: spec.name, role, relPath, dir, headSha: spec.commitSha, baseSha: spec.baseSha };
}

/**
 * A filesystem-safe directory name for a repo (`owner/repo` -> `owner__repo`),
 * unique within the workspace. A collision gets a numeric suffix.
 */
function uniqueDirName(name: string, used: Set<string>): string {
    const base =
        name
            .replace(/\//g, "__")
            .replace(/[^A-Za-z0-9._-]/g, "-")
            .replace(/^-+|-+$/g, "") || "repo";
    let candidate = base;
    let counter = 2;
    while (used.has(candidate)) {
        candidate = `${base}-${counter}`;
        counter += 1;
    }
    used.add(candidate);
    return candidate;
}
