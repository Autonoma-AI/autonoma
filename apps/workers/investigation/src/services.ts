import { type GitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { type ModelSession, openModelSession } from "@autonoma/investigation";
import { S3Storage } from "@autonoma/storage";
import { env } from "./env";

let githubAppSingleton: GitHubApp | undefined;

/** The GitHub App (for cloning client repos), constructed once. */
export function getGithubApp(): GitHubApp {
    if (githubAppSingleton == null) {
        githubAppSingleton = new OctokitGitHubApp({
            appId: env.GITHUB_APP_ID,
            privateKey: env.GITHUB_APP_PRIVATE_KEY,
            webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
            appSlug: env.GITHUB_APP_SLUG,
        });
    }
    return githubAppSingleton;
}

/**
 * Open a fresh, metered model session for one activity (reuses @autonoma/ai's registry: smart-visual
 * Gemini-Flash via OpenRouter + the local native-OpenAI gpt-5.5 classifier).
 */
export function createModelSession(): ModelSession {
    return openModelSession({
        openaiApiKey: env.OPENAI_API_KEY,
        classifierModelId: env.INVESTIGATION_CLASSIFIER_MODEL,
    });
}

let storageSingleton: S3Storage | undefined;

/** The S3 storage client (report upload + run-media download), constructed once. */
export function getStorage(): S3Storage {
    if (storageSingleton == null) {
        storageSingleton = S3Storage.createFromEnv();
    }
    return storageSingleton;
}
