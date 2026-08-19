import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Codebase } from "@autonoma/diffs";
import { type GitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { ensurePem } from "@autonoma/github/schemas";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { z } from "zod";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Default on-disk repo cache, gitignored, shared across every eval run in this app. */
const DEFAULT_CACHE_ROOT = path.resolve(__dirname, "..", ".cache", "repos");

/** Per-repo worktrees live in a sibling dir so the base clone's own tree is never disturbed. */
const WORKTREES_SUFFIX = ".worktrees";

/** Cap on a sanitized worktree label, so per-case worktree paths stay sane. */
const MAX_LABEL_LENGTH = 60;

/**
 * One base clone per repo, cloned at most once and shared as the object store for every case's
 * worktree. Keyed by repo dir; the entry is evicted on failure so a later case can retry.
 */
const baseClones = new Map<string, Promise<void>>();

/** Serializes the `.git`-mutating plumbing (fetch, worktree add/remove) per repo dir. */
const repoLocks = new Map<string, Promise<void>>();

/** Monotonic id making each case's worktree dir unique within a run. */
let worktreeSeq = 0;

/**
 * The git coordinates of a frozen eval case, stored in `input.json` in place of
 * the live {@link Codebase}. `ensureCachedCheckout` rehydrates a real clone from
 * these at run time. Both `baseSha` and `headSha` must be reachable so the
 * analysis agent can diff `base..head`.
 */
export const codebaseCoordsSchema = z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    /** GitHub App installation id used to mint a token for the clone/fetch. */
    installationId: z.number().int().positive(),
    baseSha: z.string().min(1),
    headSha: z.string().min(1),
});

export type CodebaseCoords = z.infer<typeof codebaseCoordsSchema>;

/**
 * Thrown when a commit cannot be fetched from the remote - typically because it
 * was force-pushed away or its branch was deleted. Capture refuses to freeze a
 * case in this state; the eval suite skips such a case with a warning rather
 * than red-failing.
 */
export class UnfetchableShaError extends Error {
    constructor(
        public readonly sha: string,
        public readonly repoFullName: string,
        options?: { cause?: unknown },
    ) {
        super(
            `Commit ${sha} is not fetchable from ${repoFullName} (it may have been force-pushed away or its branch deleted)`,
            options,
        );
        this.name = "UnfetchableShaError";
    }
}

export interface EnsureCachedCheckoutOptions {
    /** Override the cache root (defaults to a gitignored dir under `evals/.cache/repos`). */
    cacheRoot?: string;
    /** Override the GitHub App (defaults to one built from this app's env). */
    githubApp?: GitHubApp;
    /** Human-readable label (e.g. the case name) used to name this checkout's worktree dir. */
    label?: string;
    logger?: Logger;
}

/**
 * A per-case checkout: the {@link Codebase} rooted at its own git worktree, plus the `dispose` that
 * removes that worktree. The holder owns the worktree and must dispose it when done - the eval
 * framework wires `dispose` to `onCleanup` so each concurrent case reclaims its own tree.
 */
export interface CheckoutHandle {
    codebase: Codebase;
    dispose(): Promise<void>;
}

let githubAppSingleton: GitHubApp | undefined;

/**
 * Build the default GitHub App from this app's env, lazily and via dynamic
 * import. Deferring the import means the env (which requires the GITHUB_APP_*
 * credentials) is only validated when a token actually has to be minted - so an
 * eval over a public repo, or one whose SHAs are already cached, runs with no
 * GitHub credentials at all.
 */
async function loadDefaultGithubApp(): Promise<GitHubApp> {
    if (githubAppSingleton == null) {
        const { env } = await import("../../src/env");
        githubAppSingleton = new OctokitGitHubApp({
            appId: env.GITHUB_APP_ID,
            // Evals run under TESTING=true, which makes createEnv skip the base64PrivateKey transform,
            // so the key may still be base64 here. Decode it, or no installation token can be minted and
            // every private-repo case silently falls back to an unauthenticated clone.
            privateKey: ensurePem(env.GITHUB_APP_PRIVATE_KEY),
            webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
            appSlug: env.GITHUB_APP_SLUG,
        });
    }
    return githubAppSingleton;
}

/** A warmed repo cache: the base clone exists with the case's commits fetched and validated. */
interface RepoCacheContext {
    repoDir: string;
    worktreesDir: string;
    logger: Logger;
}

/**
 * Clone-once and fetch the case's commits into the shared cache, validating both are reachable - the
 * half of a checkout that warms the cache WITHOUT materializing a working tree. A fresh App
 * installation token is minted lazily - only when a clone or fetch actually needs the network - and
 * used inline, never persisted into the clone's git config. A repo whose SHAs are already cached needs
 * no token, and public repos work unauthenticated. Throws {@link UnfetchableShaError} if either SHA
 * cannot be fetched.
 */
async function fetchIntoCache(coords: CodebaseCoords, options: EnsureCachedCheckoutOptions): Promise<RepoCacheContext> {
    const { owner, repo, installationId, baseSha, headSha } = coords;
    const repoFullName = `${owner}/${repo}`;
    const cacheRoot = options.cacheRoot ?? DEFAULT_CACHE_ROOT;
    const repoDir = path.join(cacheRoot, `${owner}__${repo}`);
    const worktreesDir = `${repoDir}${WORKTREES_SUFFIX}`;
    const logger = (options.logger ?? rootLogger).child({ name: "ensureCachedCheckout" });

    logger.info("Fetching case commits into cache", { extra: { repoFullName, repoDir, baseSha, headSha } });

    const publicUrl = `https://github.com/${repoFullName}.git`;

    // Mint the App token lazily and at most once: a cached repo whose SHAs are already present needs
    // no network at all, and public repos clone/fetch unauthenticated. Falls back to the public URL
    // if a token can't be minted.
    const getCloneUrl = memoizedCloneUrl({
        githubApp: options.githubApp,
        installationId,
        repoFullName,
        publicUrl,
        logger,
    });

    await ensureBaseClone({ repoDir, worktreesDir, getCloneUrl, publicUrl, logger });

    // Fetch both commits under the per-repo lock: fetch mutates the shared `.git`, so concurrent cases
    // would race. The worktree add and the model work both happen outside this section.
    await withRepoLock(repoDir, async () => {
        await fetchSha({ repoDir, getCloneUrl, sha: headSha, repoFullName, logger });
        await fetchSha({ repoDir, getCloneUrl, sha: baseSha, repoFullName, logger });
    });

    await assertReachable({ repoDir, sha: baseSha, repoFullName });

    return { repoDir, worktreesDir, logger };
}

/**
 * Warm the repo cache for a case's coords and validate both SHAs are fetchable, without materializing
 * a working tree. Capture wants exactly this - a warm cache and a fetchability check - so it never
 * pays to add and remove a worktree it would not use. Throws {@link UnfetchableShaError} if either SHA
 * cannot be fetched.
 */
export async function ensureFetchable(
    coords: CodebaseCoords,
    options: EnsureCachedCheckoutOptions = {},
): Promise<void> {
    await fetchIntoCache(coords, options);
}

/**
 * Rehydrate a {@link Codebase} from git coordinates against a persistent, gitignored repo cache,
 * isolated in its own git worktree so cases can run concurrently.
 *
 * Warms the cache (see {@link fetchIntoCache}), then cuts a fresh worktree detached at `headSha` under
 * the per-repo lock (worktree bookkeeping mutates the shared `.git`); everything the caller does with
 * the returned worktree afterwards is fully parallel. Both `baseSha` and `headSha` are reachable in
 * the worktree, so `base..head` diffing works.
 *
 * The caller OWNS the returned worktree and MUST call `dispose()` when done to remove it. Any tree
 * leaked by a crash is reclaimed by the next run's `worktree prune`.
 */
export async function ensureCachedCheckout(
    coords: CodebaseCoords,
    options: EnsureCachedCheckoutOptions = {},
): Promise<CheckoutHandle> {
    const { repoDir, worktreesDir, logger } = await fetchIntoCache(coords, options);

    const label = sanitizeLabel(options.label ?? coords.headSha.slice(0, 12));
    const worktreeDir = path.join(worktreesDir, `${label}-${nextWorktreeId()}`);

    await withRepoLock(repoDir, async () => {
        logger.info("Adding case worktree", { extra: { worktreeDir, headSha: coords.headSha } });
        await git(repoDir, ["worktree", "add", "--detach", worktreeDir, coords.headSha]);
    });

    logger.info("Cached checkout ready", { extra: { worktreeDir } });
    return {
        codebase: new Codebase(worktreeDir),
        dispose: () => removeWorktree({ repoDir, worktreeDir, logger }),
    };
}

/**
 * Clone the repo once and reuse it as the shared object store for every case's worktree. Memoized
 * per repo dir so N concurrent cases for one repo trigger a single clone; the memo is evicted on
 * failure so a later case can retry. Before any worktree is added, this reclaims trees left by a
 * previous crashed run - remove the dirs, then prune git's now-dangling admin entries - so fresh
 * per-case worktrees never collide with a stale one.
 */
function ensureBaseClone(params: {
    repoDir: string;
    worktreesDir: string;
    getCloneUrl: () => Promise<string>;
    publicUrl: string;
    logger: Logger;
}): Promise<void> {
    const cached = baseClones.get(params.repoDir);
    if (cached != null) return cached;

    const pending = prepareBaseClone(params).catch((err) => {
        baseClones.delete(params.repoDir);
        throw err;
    });
    baseClones.set(params.repoDir, pending);
    return pending;
}

async function prepareBaseClone(params: {
    repoDir: string;
    worktreesDir: string;
    getCloneUrl: () => Promise<string>;
    publicUrl: string;
    logger: Logger;
}): Promise<void> {
    const { repoDir, worktreesDir, getCloneUrl, publicUrl, logger } = params;

    if (!existsSync(path.join(repoDir, ".git"))) {
        await cloneInto({ repoDir, getCloneUrl, publicUrl, logger });
    } else {
        logger.info("Reusing existing clone");
    }

    await rm(worktreesDir, { recursive: true, force: true });
    await git(repoDir, ["worktree", "prune"]);
}

/**
 * Serialize the `.git`-mutating plumbing (fetch, worktree add/remove) for one repo. These race under
 * concurrent access; the model work that follows does not, so only the few seconds of plumbing are
 * serialized, never the minutes of the run. Rejections are swallowed from the stored chain so one
 * case's failure never wedges the next.
 */
function withRepoLock<T>(repoDir: string, work: () => Promise<T>): Promise<T> {
    const previous = repoLocks.get(repoDir) ?? Promise.resolve();
    const result = previous.then(work, work);
    repoLocks.set(
        repoDir,
        result.then(
            () => undefined,
            () => undefined,
        ),
    );
    return result;
}

/**
 * Remove a case's worktree. Best-effort: a failed removal is logged, not thrown - the case it belongs
 * to has already produced its result, and any leftover tree is reclaimed by the next run's prune.
 */
async function removeWorktree(params: { repoDir: string; worktreeDir: string; logger: Logger }): Promise<void> {
    const { repoDir, worktreeDir, logger } = params;
    try {
        await withRepoLock(repoDir, () => git(repoDir, ["worktree", "remove", "--force", worktreeDir]));
        logger.info("Removed case worktree", { extra: { worktreeDir } });
    } catch (err) {
        logger.warn("Failed to remove case worktree; it will be pruned on the next run", {
            extra: { worktreeDir, err },
        });
    }
}

/** A filesystem-safe, bounded worktree label. */
function sanitizeLabel(label: string): string {
    const safe = label
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, MAX_LABEL_LENGTH);
    return safe.length > 0 ? safe : "case";
}

function nextWorktreeId(): number {
    worktreeSeq += 1;
    return worktreeSeq;
}

/** Lazily resolve the URL to clone/fetch from, minting an App token once and caching the result. */
function memoizedCloneUrl(deps: {
    githubApp?: GitHubApp;
    installationId: number;
    repoFullName: string;
    publicUrl: string;
    logger: Logger;
}): () => Promise<string> {
    let resolved: string | undefined;
    return async () => {
        if (resolved != null) return resolved;
        try {
            const githubApp = deps.githubApp ?? (await loadDefaultGithubApp());
            const client = await githubApp.getInstallationClient(deps.installationId);
            const token = await client.getInstallationToken();
            resolved = `https://x-access-token:${token}@github.com/${deps.repoFullName}.git`;
        } catch (err) {
            deps.logger.warn("Could not mint installation token; using unauthenticated access (public repos only)", {
                extra: { repoFullName: deps.repoFullName, err },
            });
            resolved = deps.publicUrl;
        }
        return resolved;
    };
}

async function cloneInto(params: {
    repoDir: string;
    getCloneUrl: () => Promise<string>;
    publicUrl: string;
    logger: Logger;
}): Promise<void> {
    const { repoDir, getCloneUrl, publicUrl, logger } = params;
    logger.info("Cloning repository into cache (first run)");
    const cloneUrl = await getCloneUrl();
    // Clone with the (possibly authed) URL, then immediately scrub any token out
    // of the persisted remote config - later fetches pass the URL inline.
    await execFileAsync("git", ["clone", "--no-tags", cloneUrl, repoDir], {
        maxBuffer: 50 * 1024 * 1024,
        timeout: 300_000,
    });
    await git(repoDir, ["remote", "set-url", "origin", publicUrl]);
}

async function fetchSha(params: {
    repoDir: string;
    getCloneUrl: () => Promise<string>;
    sha: string;
    repoFullName: string;
    logger: Logger;
}): Promise<void> {
    const { repoDir, getCloneUrl, sha, repoFullName, logger } = params;

    // Already present (e.g. fetched on a previous run) - skip the network call.
    if (await isReachable(repoDir, sha)) {
        logger.info("Commit already present in cache", { extra: { sha } });
        return;
    }

    logger.info("Fetching commit", { extra: { sha } });
    try {
        const fetchUrl = await getCloneUrl();
        await execFileAsync("git", ["fetch", "--no-tags", fetchUrl, sha], {
            cwd: repoDir,
            maxBuffer: 50 * 1024 * 1024,
            timeout: 120_000,
        });
    } catch (error) {
        throw new UnfetchableShaError(sha, repoFullName, { cause: error });
    }
}

async function assertReachable(params: { repoDir: string; sha: string; repoFullName: string }): Promise<void> {
    const { repoDir, sha, repoFullName } = params;
    if (!(await isReachable(repoDir, sha))) {
        throw new UnfetchableShaError(sha, repoFullName);
    }
}

async function isReachable(repoDir: string, sha: string): Promise<boolean> {
    try {
        const { stdout } = await execFileAsync("git", ["cat-file", "-t", sha], { cwd: repoDir });
        return stdout.trim() === "commit";
    } catch {
        return false;
    }
}

async function git(repoDir: string, args: string[]): Promise<void> {
    await execFileAsync("git", args, { cwd: repoDir, maxBuffer: 50 * 1024 * 1024, timeout: 120_000 });
}
