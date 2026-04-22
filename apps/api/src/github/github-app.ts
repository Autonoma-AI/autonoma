import { type GitHubApp, LocalDevGitHubApp, OctokitGitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import type { env as apiEnv } from "../env";

type ApiEnv = typeof apiEnv;

export function buildGitHubApp(env: ApiEnv): GitHubApp {
    if (env.LOCAL_DEV) {
        logger.info("LOCAL_DEV=true - using LocalDevGitHubApp (fake GitHub integration)");
        return new LocalDevGitHubApp();
    }

    const missing = getMissingGitHubCredentials(env);
    if (missing.length > 0) {
        throw new Error(
            `Missing GitHub app credentials: ${missing.join(", ")}. Set them, or set LOCAL_DEV=true to use the fake app.`,
        );
    }

    return new OctokitGitHubApp({
        appId: env.GITHUB_APP_ID!,
        privateKey: env.GITHUB_APP_PRIVATE_KEY!,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET!,
        appSlug: env.GITHUB_APP_SLUG!,
    });
}

function getMissingGitHubCredentials(env: ApiEnv): string[] {
    const missing: string[] = [];
    if (env.GITHUB_APP_ID == null) missing.push("GITHUB_APP_ID");
    if (env.GITHUB_APP_PRIVATE_KEY == null) missing.push("GITHUB_APP_PRIVATE_KEY");
    if (env.GITHUB_APP_WEBHOOK_SECRET == null) missing.push("GITHUB_APP_WEBHOOK_SECRET");
    if (env.GITHUB_APP_SLUG == null) missing.push("GITHUB_APP_SLUG");
    return missing;
}
