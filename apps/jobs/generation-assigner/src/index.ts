import { db } from "@autonoma/db";
import { GitHubApp } from "@autonoma/github";
import { logger, runWithSentry } from "@autonoma/logger";
import { CommitDiffHandler, TestSuiteUpdater } from "@autonoma/test-updates";
import { triggerDiffsJob } from "@autonoma/workflow";
import { env } from "./env";

const githubApp = new GitHubApp({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
    appSlug: env.GITHUB_APP_SLUG,
});

const commitDiffHandler = new CommitDiffHandler(db, githubApp, triggerDiffsJob);

const generationIds = process.argv.slice(2);
if (generationIds.length === 0) {
    console.error("Usage: generation-assigner <generationId1> <generationId2> ...");
    process.exit(1);
}

async function main() {
    logger.info("Starting generation assigner", { generationIds });

    const firstGeneration = await db.testGeneration.findUniqueOrThrow({
        // biome-ignore lint/style/noNonNullAssertion: validated above
        where: { id: generationIds[0]! },
        select: { snapshot: { select: { branchId: true } } },
    });

    const branchId = firstGeneration.snapshot.branchId;
    logger.info("Resolved branch from generation", { branchId });

    const updater = await TestSuiteUpdater.continueUpdate({
        db,
        branchId,
        commitDiffHandler,
    });
    const { assigned, failed } = await updater.assignGenerationResults(generationIds);
    logger.info("Generation results assigned", { assigned, failed });

    const autoActivate = env.AUTO_ACTIVATE === "true";
    if (autoActivate) {
        await updater.finalize();
        logger.info("Snapshot finalized");
    } else {
        logger.info("Skipping finalization (ACTIVATE=false)");
    }
}

await runWithSentry({ name: "generation-assigner", tags: { generationCount: String(generationIds.length) } }, () =>
    main(),
);
