import { type GitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { env } from "./env";

/** Build a GitHub App client from this worker's env credentials. */
export function createGithubApp(): GitHubApp {
    return new OctokitGitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });
}
