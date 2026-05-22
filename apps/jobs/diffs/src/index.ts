import { logger, withObservabilityContext } from "@autonoma/logger";
import { jobEnv } from "./job-env";
import { runDiffsAnalysis } from "./run";

await withObservabilityContext({ job: { jobName: "diffs" } }, async () => {
    logger.info("Starting diffs analysis job");

    try {
        const result = await runDiffsAnalysis(jobEnv.BRANCH_ID);
        logger.info("Diffs analysis complete", {
            extra: {
                affectedTests: result.affectedTests.length,
                testCandidates: result.testCandidates.length,
                reasoning: result.reasoning.slice(0, 500),
            },
        });
        process.exit(0);
    } catch (error) {
        logger.error("Diffs analysis failed", error);
        process.exit(1);
    }
});
