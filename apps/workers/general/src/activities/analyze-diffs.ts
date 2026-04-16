import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { prepareRuns } from "@autonoma/diffs/prepare-runs";
import { runDiffsAnalysis } from "@autonoma/job-diffs/run";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalyzeDiffsInput, AnalyzeDiffsOutput, PreparedRunInfo } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function analyzeDiffs({ branchId }: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput> {
    const logger = rootLogger.child({ name: "analyzeDiffs", branchId });
    logger.info("Starting diffs analysis");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        const agentResult = await runDiffsAnalysis(branchId);
        logger.info("Agent analysis complete, preparing runs", {
            affectedTests: agentResult.affectedTests.length,
        });

        let preparedRuns: PreparedRunInfo[] = [];

        if (agentResult.affectedTests.length > 0) {
            const { applicationId, organizationId } = await db.branch.findUniqueOrThrow({
                where: { id: branchId },
                select: { applicationId: true, organizationId: true },
            });
            const billingService = createBillingService(db);

            const runs = await prepareRuns(
                agentResult.affectedTests.map((t) => t.slug),
                { db, applicationId, organizationId, billingService },
            );

            preparedRuns = runs.map((r) => ({
                runId: r.runId,
                slug: r.slug,
                architecture: r.architecture as "WEB" | "IOS" | "ANDROID",
                scenarioId: r.scenarioId,
            }));
        }

        logger.info("Diffs analysis activity completed", {
            preparedRuns: preparedRuns.length,
            reasoning: agentResult.reasoning.slice(0, 200),
        });

        return {
            preparedRuns,
            testCandidates: agentResult.testCandidates,
            reasoning: agentResult.reasoning,
        };
    } finally {
        clearInterval(heartbeat);
    }
}
