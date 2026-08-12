import { execFile } from "node:child_process";
import { relative, sep } from "node:path";
import { promisify } from "node:util";
import { debugLog } from "../../core/debug";

const exec = promisify(execFile);

const HISTORY_WINDOW = "18.months";
/** Files reported back to the agent, most-retouched first. Enough to see the shape, small enough to read. */
const TOP_FILES = 40;
/**
 * Share of the window reserved for the app under test. The `git log` sees the
 * whole repository, so on a monorepo sibling apps and shared packages compete
 * for slots with the frontend we are actually testing - and a busy sibling
 * (e.g. a heavily-corrected backend service) can crowd the real product
 * surfaces out entirely. Reserving most of the window for the app under test
 * keeps the fragile frontend files in view, while the remaining slots still go
 * to the most-corrected code elsewhere in the repo - which is exactly the
 * "a backend module feeding a flow carries risk into the UI" signal we want to
 * keep. The split only applies when the app is a subdirectory of the repo;
 * when the repo IS the app, the whole window is naturally the product.
 */
const FRONTEND_WINDOW_SHARE = 0.85;
/** Commit subjects shown per file. Sampling, not a census - the agent is judging character, not counting. */
const SUBJECTS_PER_FILE = 5;
/** A file touched again within this many days was probably being corrected, not extended. */
const RETOUCH_WINDOW_DAYS = 7;
const MS_PER_DAY = 86_400_000;
const GIT_TIMEOUT_MS = 120_000;
const MAX_BUFFER_BYTES = 256 * 1024 * 1024;

/**
 * Paths whose churn says nothing about how hard a user-facing surface is to get
 * right, and which crowd the window out of all proportion on a monorepo: a
 * lockfile is rewritten on every dependency bump, generated code churns in
 * lockstep with its source, IaC and CI config change on their own schedule. On
 * one measured monorepo the lockfile alone was the single most-changed file in
 * the whole history. Unlike shared helpers or a product's own backend - whose
 * churn CAN carry risk into the UI, and which this module deliberately leaves
 * for the agent to judge (see renderRepoSignals) - there is nothing here to
 * judge: no project's product is its `pnpm-lock.yaml`. These are the one class
 * of path filtered outright, as patterns (not values) so `.some` is the right
 * shape; every ambiguous "is this product code?" call stays with the agent.
 */
const NOISE_PATH_PATTERNS: readonly RegExp[] = [
    // Dependency lockfiles.
    /(^|\/)[^/]+\.lock$/i,
    /(^|\/)(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|composer\.lock|Gemfile\.lock)$/i,
    // Vendored / installed dependencies.
    /(^|\/)(node_modules|vendor|\.venv|venv)\//,
    // Build output and caches.
    /(^|\/)(dist|build|out|coverage|\.next|\.turbo|\.cache)\//,
    /\.min\.(js|css)$/i,
    // Generated code - churns with its source, adds no independent signal.
    /(^|\/)generated\//i,
    /(\.|_)generated\.[^/]+$/i,
    /\.gen\.[^/]+$/i,
    // Infrastructure-as-code, schema tooling, and repo/CI configuration.
    /\.tf$/i,
    /(^|\/)\.?terraform\//i,
    /(^|\/)atlas\.(sum|hcl)$/i,
    /(^|\/)turbo\.json$/i,
    /(^|\/)\.github\//,
    // Test and mock files - a feature's fragility shows in its source, not its test.
    /(\.|_)(test|spec)\.[^/]+$/i,
    /(^|\/)(__tests__|__mocks__)\//,
];

function isNoisePath(path: string): boolean {
    return NOISE_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/** Per-file history, for files the agent may care about. */
export interface FileSignal {
    path: string;
    commits: number;
    /** Times this file was changed again within a week of its previous change. */
    retouches: number;
    /** A sample of what people said when they changed it. */
    subjects: string[];
}

export interface RepoSignals {
    totalCommits: number;
    /** Share of subjects shaped like `type(scope): summary`, so the agent knows how much to trust them. */
    conventionalShare: number;
    files: FileSignal[];
}

/**
 * Read what the repository's own history says about where work concentrates.
 *
 * Deliberately no classification here. Deciding which commits are fixes by
 * pattern-matching their subjects does not survive contact with real repos - a
 * `fix|bug|revert` match scored 36-43% across every area of one product, which
 * is the repo-wide base rate and separates nothing, and one of the four repos
 * measured writes conventional commits in 2% of its history. So this collects
 * evidence and hands it over; the agent reads the subjects and judges.
 *
 * `retouches` is the part that needs no convention at all: a file changed again
 * within a week was usually being corrected. It means the same thing whether a
 * team writes `fix(auth):` or `asdf`.
 */
export async function collectRepoSignals(projectRoot: string): Promise<RepoSignals | undefined> {
    const [log, repoRoot] = await Promise.all([readHistory(projectRoot), readRepoRoot(projectRoot)]);
    if (log == null) return undefined;

    const commits = parseCommits(log);
    if (commits.length === 0) return undefined;

    const byFile = new Map<string, { commits: number; retouches: number; subjects: string[]; lastAt?: number }>();
    for (const commit of commits) {
        for (const path of commit.files) {
            if (isNoisePath(path)) continue;
            const entry = byFile.get(path) ?? { commits: 0, retouches: 0, subjects: [] };
            entry.commits += 1;
            if (entry.lastAt != null && entry.lastAt - commit.at <= RETOUCH_WINDOW_DAYS * MS_PER_DAY) {
                entry.retouches += 1;
            }
            entry.lastAt = commit.at;
            if (entry.subjects.length < SUBJECTS_PER_FILE) entry.subjects.push(commit.subject);
            byFile.set(path, entry);
        }
    }

    const allFiles: FileSignal[] = [...byFile.entries()].map(([path, e]) => ({
        path,
        commits: e.commits,
        retouches: e.retouches,
        subjects: e.subjects,
    }));

    return {
        totalCommits: commits.length,
        conventionalShare: conventionalShare(commits.map((c) => c.subject)),
        files: selectWindow(allFiles, frontendPrefix(repoRoot, projectRoot)),
    };
}

/**
 * The prefix, relative to the repo root, that marks a file as part of the app
 * under test. `undefined` when the repo IS the app (or the app is not inside
 * this repo), in which case there is no sibling code to reserve slots against.
 */
function frontendPrefix(repoRoot: string | undefined, projectRoot: string): string | undefined {
    if (repoRoot == null) return undefined;
    const rel = relative(repoRoot, projectRoot);
    if (rel.length === 0 || rel.startsWith("..")) return undefined;
    return `${rel.split(sep).join("/")}/`;
}

/**
 * Choose the files the agent sees. Everything is ranked by retouch (with churn
 * as the tiebreak); retouch - a file changed again within a week - is the
 * fragility signal this module exists to surface, so a high-churn but stable
 * file no longer evicts a smaller fragile one.
 *
 * On a monorepo the ranking alone is not enough: the `git log` covers the whole
 * repository, so sibling apps and shared packages - some of them busy enough to
 * out-rank the frontend - would crowd the app under test out of the window.
 * So the app gets first pick of a reserved share; the rest of the repo competes
 * for the remaining slots (keeping the most-corrected backend/shared code, the
 * signal we want). Either side backfills the other, so a small app or a
 * repo-is-the-app layout still fills the window.
 */
function selectWindow(files: FileSignal[], prefix: string | undefined): FileSignal[] {
    const byRetouch = (a: FileSignal, b: FileSignal): number => b.retouches - a.retouches || b.commits - a.commits;
    const ranked = [...files].sort(byRetouch);
    if (prefix == null) return ranked.slice(0, TOP_FILES);

    const frontend = ranked.filter((f) => f.path.startsWith(prefix));
    const rest = ranked.filter((f) => !f.path.startsWith(prefix));
    const reserve = Math.ceil(TOP_FILES * FRONTEND_WINDOW_SHARE);
    const frontendTake = Math.min(frontend.length, reserve);

    const chosen = [...frontend.slice(0, frontendTake), ...rest.slice(0, TOP_FILES - frontendTake)];
    if (chosen.length < TOP_FILES)
        chosen.push(...frontend.slice(frontendTake, frontendTake + (TOP_FILES - chosen.length)));
    return chosen.sort(byRetouch);
}

/**
 * Render the signals for the agent, with the caveats that decide how to read
 * them. Unambiguous machine-generated / dependency / infrastructure paths are
 * already filtered upstream (see NOISE_PATH_PATTERNS). The exclusions stated
 * here are the AMBIGUOUS ones - shared helpers, a product's own backend - left
 * as reasoning rather than applied as filters, because which directories are
 * shared helpers and which are real features is a judgment about this specific
 * codebase: a pattern that strips `utils` everywhere will be wrong somewhere -
 * it cannot know that one project's `lib/core` is its product and another's is a
 * junk drawer.
 */
export function renderRepoSignals(signals: RepoSignals): string {
    const trust =
        signals.conventionalShare >= 0.5
            ? `${Math.round(signals.conventionalShare * 100)}% of commits follow a conventional \`type(scope):\` format, so their subjects are a reliable label.`
            : `Only ${Math.round(signals.conventionalShare * 100)}% of commits follow a conventional format, so subjects are informal - read them for meaning, do not expect a prefix.`;

    const rows = signals.files
        .map(
            (f) =>
                `  ${String(f.commits).padStart(4)} changes, ${String(f.retouches).padStart(3)} within a week  ${f.path}\n      ${f.subjects.join(" | ")}`,
        )
        .join("\n");

    return `
## Where this codebase actually changes

${signals.totalCommits} commits in the last 18 months. ${trust}

The most-changed files, with a sample of what was said when they changed. A file
changed again within a week of its last change was usually being corrected rather
than extended, so a high re-touch count is a sign of a surface that is hard to get
right.

${rows}

Reading it:
- Judge the subjects yourself. Repeated corrections to one surface mean something;
  steady feature work does not.
- Lockfiles, generated code, build output and infrastructure config have already
  been filtered out. What remains can still be misleading: a shared helper that
  everything imports accumulates changes without being a user-facing risk. You can
  see the paths - decide which are product surfaces in THIS codebase and discount
  the rest.
- No history is unknown, not safe. New code has had no chance to accumulate fixes.
- Backend files are not directly testable end to end, but a flow fed by a heavily
  corrected module carries that risk into the UI.

This informs riskDrivers only.
`;
}

interface Commit {
    subject: string;
    at: number;
    files: string[];
}

async function readHistory(projectRoot: string): Promise<string | undefined> {
    try {
        const { stdout } = await exec(
            "git",
            ["log", `--since=${HISTORY_WINDOW}`, "--pretty=format:@@%ct%x09%s", "--name-only", "--no-merges"],
            { cwd: projectRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
        );
        return stdout;
    } catch (err) {
        // A shallow clone, no git at all, or a repo too large to read in time.
        // The knowledge base is still worth building without this.
        debugLog("Could not read git history for repo signals", { projectRoot, err });
        return undefined;
    }
}

/** The repo root, used to tell the app under test apart from sibling code. Absent = no scoping. */
async function readRepoRoot(projectRoot: string): Promise<string | undefined> {
    try {
        const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
            cwd: projectRoot,
            timeout: GIT_TIMEOUT_MS,
        });
        return stdout.trim();
    } catch (err) {
        debugLog("Could not resolve git repo root for repo signals", { projectRoot, err });
        return undefined;
    }
}

function parseCommits(log: string): Commit[] {
    const commits: Commit[] = [];
    let current: Commit | undefined;
    for (const line of log.split("\n")) {
        if (line.startsWith("@@")) {
            const tab = line.indexOf("\t");
            const seconds = Number(line.slice(2, tab));
            current = { subject: line.slice(tab + 1), at: Number.isFinite(seconds) ? seconds * 1000 : 0, files: [] };
            commits.push(current);
            continue;
        }
        if (line.length > 0 && current != null) current.files.push(line);
    }
    return commits;
}

/**
 * How much of the history is machine-labelled. Structural, not semantic: this
 * only asks whether subjects carry a `type(scope):` prefix, which is a format
 * question. What a commit MEANS is left to the agent.
 */
function conventionalShare(subjects: string[]): number {
    if (subjects.length === 0) return 0;
    const conventional = /^[a-z]+(\([^)]*\))?!?:/i;
    return subjects.filter((s) => conventional.test(s)).length / subjects.length;
}
