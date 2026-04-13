import { db } from "@autonoma/db";
import { GitHubApp } from "@autonoma/github";
import { logger } from "@autonoma/logger";
import { CommitDiffHandler, TestSuiteUpdater } from "@autonoma/test-updates";
import { triggerDiffsJob } from "@autonoma/workflow";
import { env } from "./env";

export async function runGenerationAssignment(generationIds: string[], autoActivate: boolean): Promise<void> {
    logger.info("Starting generation assigner", { generationIds, autoActivate });

    const firstGeneration = await db.testGeneration.findUniqueOrThrow({
        // biome-ignore lint/style/noNonNullAssertion: validated by caller
        where: { id: generationIds[0]! },
        select: { snapshot: { select: { branchId: true } } },
    });

    const branchId = firstGeneration.snapshot.branchId;
    logger.info("Resolved branch from generation", { branchId });

    const githubApp = new GitHubApp({
        appId: env.GITHUB_APP_ID,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
        appSlug: env.GITHUB_APP_SLUG,
    });

    const commitDiffHandler = new CommitDiffHandler(db, githubApp, triggerDiffsJob);

    const updater = await TestSuiteUpdater.continueUpdate({
        db,
        branchId,
        commitDiffHandler,
    });
    const { assigned, failed } = await updater.assignGenerationResults(generationIds);
    logger.info("Generation results assigned", { assigned, failed });

    if (autoActivate) {
        await updater.finalize();
        logger.info("Snapshot finalized");
    } else {
        logger.info("Skipping finalization (autoActivate=false)");
    }
}
