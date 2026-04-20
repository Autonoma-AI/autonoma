import { logger, runWithSentry } from "@autonoma/logger";
import { env } from "./env";
import { jobEnv } from "./job-env";
import { runDiffsAnalysis } from "./run";

async function main(): Promise<void> {
    logger.info("Starting diffs analysis job", { branchId: jobEnv.BRANCH_ID });

    const result = await runDiffsAnalysis(jobEnv.BRANCH_ID);

    logger.info("Diffs analysis complete", {
        affectedTests: result.affectedTests.length,
        testCandidates: result.testCandidates.length,
        reasoning: result.reasoning.slice(0, 500),
    });
}

await runWithSentry({ name: "diffs-job", tags: { branch_id: jobEnv.BRANCH_ID }, dsn: env.SENTRY_DSN_DIFFS }, main);
