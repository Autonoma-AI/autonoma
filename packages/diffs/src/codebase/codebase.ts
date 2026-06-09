import type { GitHubInstallationClient } from "@autonoma/github";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { rimraf } from "rimraf";

/**
 * "The user's source tree at a specific commit", exposing its on-disk `root`.
 *
 * Get one via `Codebase.clone(...)`, or construct directly
 * (`new Codebase(path)`) when you already have a populated tree (tests,
 * etc.). Reuse across multiple operations is the default; call `dispose()`
 * explicitly if you want the directory removed.
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

    constructor(public readonly root: string) {
        this.logger = rootLogger.child({ name: this.constructor.name, root });
    }

    /**
     * Shells out to `cloneRepository()` from `@autonoma/github` and returns a
     * `Codebase` rooted at `targetDir`. Clears `targetDir` first so a dangling
     * tree from a previous crashed run never interferes with the fresh clone.
     * Throws on any failure (removing the partially-populated `targetDir`
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
        // Clear any dangling tree left by a previous crashed/aborted run before
        // cloning, so a fresh clone never lands on top of stale files.
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

    /** Remove the on-disk directory. Explicit, never auto-called. */
    async dispose(): Promise<void> {
        this.logger.info("Disposing codebase clone");
        await rimraf(this.root);
    }
}
