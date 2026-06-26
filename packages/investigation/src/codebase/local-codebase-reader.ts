import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { CodebaseReader } from "../classify/dependencies";

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const GREP_MAX_MATCHES = "80";

/** Diff noise that explodes the model context without helping selection/classification (lockfiles, builds). */
const DIFF_EXCLUDE_PATHSPECS = [
    ":(exclude)**/pnpm-lock.yaml",
    ":(exclude)**/package-lock.json",
    ":(exclude)**/yarn.lock",
    ":(exclude)**/*.lock",
    ":(exclude)**/dist/**",
    ":(exclude)**/*.min.js",
    ":(exclude)**/*.snap",
];
/** Cap the whole-PR diff so a huge change can't blow past the model's context window (~40k tokens). */
const MAX_DIFF_CHARS = 150_000;

/** ripgrep / git diff exit 1 when there are no matches/changes - a valid empty result, not a failure. */
function isNoMatchExit(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === 1;
}

/**
 * Implements CodebaseReader against a cloned repo. File reads use Node's fs directly (no `sed` - plain string
 * slicing, no subprocess). Search uses ripgrep (fast, self-contained, and can reach ignored / node_modules
 * content that `git grep` can't); diff uses `git`. The worker clones via the diffs `Codebase` and constructs
 * this with the clone's root + the PR's SHAs.
 */
export class LocalCodebaseReader implements CodebaseReader {
    constructor(
        private readonly root: string,
        private readonly baseSha: string,
        private readonly headSha: string,
    ) {}

    private get range(): string {
        return `${this.baseSha}..${this.headSha}`;
    }

    /** Resolve a repo-relative path inside the clone, rejecting traversal outside the root. */
    private resolveInRoot(path: string): string {
        const resolved = resolve(this.root, path);
        if (resolved !== this.root && !resolved.startsWith(`${this.root}/`)) {
            throw new Error(`path escapes the repository root: ${path}`);
        }
        return resolved;
    }

    async readFile(path: string, fromLine: number, toLine: number): Promise<string> {
        const content = await readFile(this.resolveInRoot(path), "utf8");
        // 1-indexed, inclusive - the same window `sed -n 'from,to p'` produced.
        return content
            .split("\n")
            .slice(Math.max(0, fromLine - 1), toLine)
            .join("\n");
    }

    async grep(pattern: string): Promise<string> {
        try {
            // The trailing "." is required: with no path and non-TTY stdin, rg reads stdin and hangs.
            const { stdout } = await execFileAsync(
                "rg",
                ["--line-number", "--max-count", GREP_MAX_MATCHES, pattern, "."],
                { cwd: this.root, maxBuffer: MAX_BUFFER },
            );
            return stdout;
        } catch (error) {
            if (isNoMatchExit(error)) return "";
            throw error;
        }
    }

    async diff(path?: string): Promise<string> {
        // For a specific file, return its full diff; for the whole PR, drop lockfile/build noise so a large
        // change (e.g. an SDK bump) can't blow past the model's context window.
        const args =
            path != null
                ? ["diff", this.range, "--", path]
                : ["diff", this.range, "--", ".", ...DIFF_EXCLUDE_PATHSPECS];
        const { stdout } = await execFileAsync("git", args, { cwd: this.root, maxBuffer: MAX_BUFFER });
        if (stdout.length <= MAX_DIFF_CHARS) return stdout;
        return `${stdout.slice(0, MAX_DIFF_CHARS)}\n\n[... diff truncated at ${MAX_DIFF_CHARS} chars; request a specific path for the rest ...]`;
    }

    async diffStat(): Promise<string> {
        const { stdout } = await execFileAsync("git", ["diff", this.range, "--stat"], {
            cwd: this.root,
            maxBuffer: MAX_BUFFER,
        });
        return stdout;
    }
}
