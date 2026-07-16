import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { App } from "@octokit/app";
import { z } from "zod";
import { DEFAULT_GITHUB_APP_ID, type HarnessEnv, readHarnessEnv } from "./env";
import { git } from "./git";
import { repoCacheDir } from "./paths";

const execFileAsync = promisify(execFile);
const NET_TIMEOUT_MS = 300_000;
const MAX_BUFFER = 50 * 1024 * 1024;

const installationAuthSchema = z.object({ token: z.string().min(1) });

export interface CheckoutCoords {
    owner: string;
    repo: string;
    /** The chosen commit that carries the client's SDK integration (= golden). */
    sha: string;
    /** GitHub App installation id on the client org, used to mint a clone token. */
    installationId: number;
}

/**
 * Clone-once / fetch-sha / checkout a private client repo into a gitignored cache,
 * returning the repo dir. The cache is keyed by `owner__repo` and reused across
 * runs; a repo whose `sha` is already present needs no network. The resulting tree
 * is the pristine `sha` checkout - the golden integration - and callers must NOT
 * mutate it (derive the sandbox from a copy instead).
 *
 * An App installation token is minted lazily (only when the network is actually
 * needed) and passed inline to git, never persisted into the clone's remote config.
 */
export async function ensureCachedCheckout(coords: CheckoutCoords): Promise<string> {
    const { owner, repo, sha, installationId } = coords;
    const repoFullName = `${owner}/${repo}`;
    const repoDir = repoCacheDir(owner, repo);
    const publicUrl = `https://github.com/${repoFullName}.git`;

    const authedUrl = memoizedAuthedUrl(installationId, repoFullName);

    if (!existsSync(join(repoDir, ".git"))) {
        await mkdir(dirname(repoDir), { recursive: true });
        console.error(`[checkout] cloning ${repoFullName} (first run)`);
        await execFileAsync("git", ["clone", "--no-tags", await authedUrl(), repoDir], {
            maxBuffer: MAX_BUFFER,
            timeout: NET_TIMEOUT_MS,
        });
        // Scrub the token out of the persisted remote; later fetches pass it inline.
        await git(repoDir, ["remote", "set-url", "origin", publicUrl]);
    }

    if (!(await isReachable(repoDir, sha))) {
        console.error(`[checkout] fetching ${sha} for ${repoFullName}`);
        await execFileAsync("git", ["fetch", "--no-tags", await authedUrl(), sha], {
            cwd: repoDir,
            maxBuffer: MAX_BUFFER,
            timeout: NET_TIMEOUT_MS,
        });
    }

    await git(repoDir, ["checkout", "--force", "--detach", sha]);
    if (!(await isReachable(repoDir, sha))) {
        throw new Error(`Commit ${sha} is not reachable in ${repoFullName} after fetch.`);
    }
    return repoDir;
}

/** Mint the token at most once, and only when a clone/fetch actually needs it. */
function memoizedAuthedUrl(installationId: number, repoFullName: string): () => Promise<string> {
    let resolved: string | undefined;
    return async () => {
        if (resolved != null) return resolved;
        const env = readHarnessEnv();
        const app = new App({ appId: env.GITHUB_APP_ID ?? DEFAULT_GITHUB_APP_ID, privateKey: resolvePrivateKey(env) });
        const octokit = await app.getInstallationOctokit(installationId);
        const { token } = installationAuthSchema.parse(await octokit.auth({ type: "installation" }));
        resolved = `https://x-access-token:${token}@github.com/${repoFullName}.git`;
        return resolved;
    };
}

/**
 * Resolve the App private key from a PEM file (GITHUB_APP_PRIVATE_KEY_FILE) or a
 * raw PEM (GITHUB_APP_PRIVATE_KEY). The file form is preferred because a multiline
 * PEM does not survive `--env-file`.
 */
function resolvePrivateKey(env: HarnessEnv): string {
    if (env.GITHUB_APP_PRIVATE_KEY_FILE != null) return readFileSync(env.GITHUB_APP_PRIVATE_KEY_FILE, "utf-8");
    if (env.GITHUB_APP_PRIVATE_KEY != null) return env.GITHUB_APP_PRIVATE_KEY;
    throw new Error(
        "A GitHub App private key is required to fetch a client repo: set GITHUB_APP_PRIVATE_KEY_FILE (a .pem path, recommended) or GITHUB_APP_PRIVATE_KEY.",
    );
}

async function isReachable(repoDir: string, sha: string): Promise<boolean> {
    try {
        return (await git(repoDir, ["cat-file", "-t", sha])) === "commit";
    } catch {
        return false;
    }
}
