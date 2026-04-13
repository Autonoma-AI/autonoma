import { db } from "@autonoma/db";
import { GitHubApp } from "@autonoma/github";
import { CommitDiffHandler, TestSuiteUpdater } from "@autonoma/test-updates";
import { TemporalGenerationProvider } from "@autonoma/test-updates/temporal";
import { triggerDiffsJob } from "@autonoma/workflow";
import { env } from "./env";

export async function createDiffsServices(branchId: string) {
    const githubApp = new GitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });

    const jobProvider = new TemporalGenerationProvider();
    const commitDiffHandler = new CommitDiffHandler(db, githubApp, triggerDiffsJob);
    const updater = await TestSuiteUpdater.continueUpdate({ db, branchId, jobProvider, commitDiffHandler });

    return { githubApp, updater };
}
