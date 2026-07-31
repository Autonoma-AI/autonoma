import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger as rootLogger } from "@autonoma/logger";

const execFileAsync = promisify(execFile);

/** Hard cap on bytes buffered from `git`, protecting the worker from a pathological diff. */
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * The commit range a pull request spans, plus the on-disk clone to read it from. The clone is checked
 * out at `headSha` with `baseSha` also fetched, so `baseSha..headSha` resolves locally.
 */
export interface PrRange {
    /** Filesystem root of the clone (a {@link import("./codebase").Codebase}'s `root` in production). */
    root: string;
    baseSha: string;
    headSha: string;
}

/**
 * The PR's changed-files summary (`git diff --stat`) - a compact shape-of-the-change signal.
 */
export async function readPrDiffStat(range: PrRange): Promise<string> {
    const logger = rootLogger.child({ name: "readPrDiffStat" });
    const stat = await git(range.root, ["diff", commitRange(range), "--stat"]);
    logger.info("Read the PR's diff stat", { extra: { chars: stat.length } });
    return stat;
}

/** Every file the PR touched, as repo-relative paths. */
export async function readPrChangedFiles(range: PrRange): Promise<string[]> {
    const logger = rootLogger.child({ name: "readPrChangedFiles" });
    const nameOnly = await git(range.root, ["diff", commitRange(range), "--name-only"]);
    const files = nameOnly
        .trim()
        .split("\n")
        .filter((file) => file.length > 0);
    logger.info("Read the PR's changed files", { extra: { count: files.length } });
    return files;
}

/** The subject lines of the PR's commits, newest first, one per line. */
export async function readPrCommitSubjects(range: PrRange): Promise<string> {
    const logger = rootLogger.child({ name: "readPrCommitSubjects" });
    const subjects = await git(range.root, ["log", commitRange(range), "--format=%s"]);
    logger.info("Read the PR's commit subjects", { extra: { chars: subjects.length } });
    return subjects.trim();
}

function commitRange({ baseSha, headSha }: PrRange): string {
    return `${baseSha}..${headSha}`;
}

async function git(root: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: MAX_BUFFER });
    return stdout;
}
