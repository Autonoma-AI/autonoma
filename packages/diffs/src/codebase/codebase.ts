import { execFile, execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { promisify } from "node:util";
import type { GitHubInstallationClient } from "@autonoma/github";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { glob as globPackage } from "glob";
import { rimraf } from "rimraf";

const execFileAsync = promisify(execFile);

export interface ReadFileOptions {
    startLine?: number;
    endLine?: number;
}

export interface GrepOptions {
    glob?: string;
    maxResults?: number;
}

export interface GrepHit {
    path: string;
    line: number;
    match: string;
}

export interface GlobOptions {
    /** Defaults to the codebase root. Pass an absolute path or a path relative to the root. */
    cwd?: string;
    /** Additional ignore globs on top of the defaults (node_modules, dist, .git). */
    ignore?: string[];
}

export interface DirectoryEntry {
    name: string;
    type: "file" | "directory";
}

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_GLOB_IGNORES = ["**/node_modules/**", "**/dist/**", "**/.git/**"];

let ripgrepChecked = false;

function assertRipgrepAvailable(): void {
    if (ripgrepChecked) return;
    try {
        execFileSync("rg", ["--version"], { stdio: "ignore" });
        ripgrepChecked = true;
    } catch {
        throw new Error(
            "ripgrep (rg) is not installed or not found in PATH. " +
                "Install it with: brew install ripgrep (macOS), apt install ripgrep (Ubuntu), or see https://github.com/BurntSushi/ripgrep#installation",
        );
    }
}

/**
 * "The user's source tree at a specific commit", with a small read API.
 *
 * Get one via `Codebase.clone(...)`, or construct directly
 * (`new Codebase(path)`) when you already have a populated tree (tests,
 * etc.). Reuse across multiple operations is the default; call `dispose()`
 * explicitly if you want the directory removed.
 *
 * Paths passed to `readFile` / `listDirectory` are resolved relative to
 * `root` for convenience but are otherwise unconstrained: the reviewer
 * agent is trusted internal code reading the user's own repo, so we don't
 * sandbox traversal, symlinks, or absolute paths. If the agent asks for
 * `/etc/passwd` it'll get whatever `fs.readFile` returns - same as if you
 * called `fs.readFile` yourself.
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

    async readFile(path: string, options: ReadFileOptions = {}): Promise<string> {
        const absPath = resolvePath(this.root, path);
        const content = await fs.readFile(absPath, "utf-8");

        if (options.startLine == null && options.endLine == null) return content;

        const lines = content.split("\n");
        const start = Math.max(1, options.startLine ?? 1) - 1;
        const end = Math.min(lines.length, options.endLine ?? lines.length);
        return lines.slice(start, end).join("\n");
    }

    async grep(pattern: string, options: GrepOptions = {}): Promise<GrepHit[]> {
        assertRipgrepAvailable();

        const limit = options.maxResults ?? DEFAULT_GREP_LIMIT;
        const args = [
            "--no-heading",
            "--line-number",
            "--color=never",
            "--glob=!node_modules",
            "--glob=!dist",
            "--glob=!.git",
        ];

        if (options.glob != null) {
            args.push(`--glob=${options.glob}`);
        }

        args.push("-e", pattern, this.root);

        try {
            const { stdout } = await execFileAsync("rg", args, {
                cwd: this.root,
                maxBuffer: 5 * 1024 * 1024,
                timeout: 30_000,
            });
            return this.parseGrep(stdout, limit);
        } catch (error) {
            // rg exits 1 when there are no matches; treat that as empty result, not failure.
            if (isExitOne(error)) return [];
            throw error;
        }
    }

    /**
     * Match files by glob pattern. Defaults `cwd` to the codebase root and excludes
     * `node_modules`, `dist`, `.git`. Returns paths relative to `cwd`.
     */
    async glob(pattern: string, options: GlobOptions = {}): Promise<string[]> {
        const matches = await globPackage(pattern, {
            cwd: options.cwd ?? this.root,
            nodir: true,
            ignore: [...DEFAULT_GLOB_IGNORES, ...(options.ignore ?? [])],
        });
        return matches;
    }

    async listDirectory(path = "."): Promise<DirectoryEntry[]> {
        const absPath = resolvePath(this.root, path);
        const entries = await fs.readdir(absPath, { withFileTypes: true });
        return entries
            .filter((e) => e.name !== ".git")
            .map((e) => ({
                name: e.name,
                type: e.isDirectory() ? ("directory" as const) : ("file" as const),
            }));
    }

    private parseGrep(stdout: string, limit: number): GrepHit[] {
        const hits: GrepHit[] = [];
        const lines = stdout.split("\n");
        for (const raw of lines) {
            if (raw.length === 0) continue;
            const colonOne = raw.indexOf(":");
            const colonTwo = raw.indexOf(":", colonOne + 1);
            if (colonOne === -1 || colonTwo === -1) continue;
            const absolutePath = raw.slice(0, colonOne);
            const lineNum = Number.parseInt(raw.slice(colonOne + 1, colonTwo), 10);
            const match = raw.slice(colonTwo + 1);
            if (Number.isNaN(lineNum)) continue;
            const path = relativeToRoot(absolutePath, this.root);
            hits.push({ path, line: lineNum, match });
            if (hits.length >= limit) break;
        }
        return hits;
    }
}

function relativeToRoot(absolutePath: string, root: string): string {
    const normalizedRoot = root.endsWith("/") ? root : `${root}/`;
    if (absolutePath.startsWith(normalizedRoot)) return absolutePath.slice(normalizedRoot.length);
    return absolutePath;
}

function isExitOne(error: unknown): boolean {
    if (error == null || typeof error !== "object") return false;
    const code = (error as { code?: unknown }).code;
    return code === 1;
}
