import { execFile } from "node:child_process";
import { cp } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 50 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120_000;

/** Run a git command in `cwd`, returning trimmed stdout. Throws on nonzero exit. */
export async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER, timeout: GIT_TIMEOUT_MS });
    return stdout.trimEnd();
}

/**
 * Copy a directory tree, skipping heavyweight, reproducible-on-demand paths. Used
 * to derive a sandbox from the cached checkout and to stage the judge's trees.
 * `node_modules` is dropped: the case's boot hook reinstalls what it needs, and
 * copying it per run is both slow and pointless.
 */
export async function copyTree(from: string, to: string): Promise<void> {
    await cp(from, to, {
        recursive: true,
        filter: (src) => !src.split("/").includes("node_modules"),
    });
}

/** Local git identity so eval commits don't depend on the operator's global config. */
const EVAL_IDENTITY = ["-c", "user.name=autonoma-eval", "-c", "user.email=eval@autonoma.local"];

/**
 * Commit the current working tree as the "clean" baseline on top of `sha`, so the
 * agent's later edits diff cleanly against it. Returns the new commit sha. `-A`
 * captures the strip patch's deletions as well as its edits.
 */
export async function commitAll(cwd: string, message: string): Promise<string> {
    await git(cwd, ["add", "-A"]);
    await git(cwd, [...EVAL_IDENTITY, "commit", "-q", "--no-verify", "--allow-empty", "-m", message]);
    return git(cwd, ["rev-parse", "HEAD"]);
}
