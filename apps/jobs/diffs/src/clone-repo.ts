import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "@autonoma/logger";
import { App } from "@octokit/app";
import { env } from "./env";

const execFileAsync = promisify(execFile);

const REPO_DIR = "/tmp/repo";
const gitEnv = { ...process.env, GIT_LFS_SKIP_SMUDGE: "1" };

async function resolveInstallationToken(installationId: string): Promise<string> {
    const app = new App({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhooks: { secret: env.GITHUB_APP_WEBHOOK_SECRET },
    });
    const octokit = await app.getInstallationOctokit(Number(installationId));
    const { token } = (await octokit.auth({ type: "installation" })) as { token: string };
    return token;
}

export interface CloneRepoParams {
    fullName: string;
    installationId: string;
    headSha: string;
    baseSha?: string;
}

export async function cloneRepository(params: CloneRepoParams): Promise<string> {
    const { fullName, installationId, headSha, baseSha } = params;

    logger.info("Resolving GitHub installation token", { installationId });
    const token = await resolveInstallationToken(installationId);

    const cloneUrl = `https://x-access-token:${token}@github.com/${fullName}.git`;

    logger.info("Cloning repository without LFS smudge", { fullName, headSha });
    await execFileAsync("git", ["clone", "--depth=50", cloneUrl, REPO_DIR], {
        env: gitEnv,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 120_000,
    });

    logger.info("Checking out HEAD_SHA", { headSha });
    await execFileAsync("git", ["checkout", headSha], { cwd: REPO_DIR, env: gitEnv });

    if (baseSha != null) {
        logger.info("Fetching BASE_SHA", { baseSha });
        try {
            await execFileAsync("git", ["cat-file", "-t", baseSha], { cwd: REPO_DIR, env: gitEnv });
        } catch {
            await execFileAsync("git", ["fetch", "--depth=50", "origin", baseSha], {
                cwd: REPO_DIR,
                env: gitEnv,
                timeout: 60_000,
            });
        }
    }

    logger.info("Repository cloned successfully", { repoDir: REPO_DIR });
    return REPO_DIR;
}
