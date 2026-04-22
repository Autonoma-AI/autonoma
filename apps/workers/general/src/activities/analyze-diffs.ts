import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { prepareRuns } from "@autonoma/diffs/prepare-runs";
import { runDiffsAnalysis } from "@autonoma/job-diffs/run";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalyzeDiffsInput, AnalyzeDiffsOutput, PreparedRunInfo } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function analyzeDiffs({ snapshotId }: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput> {
    const logger = rootLogger.child({ name: "analyzeDiffs", snapshotId });
    logger.info("Starting diffs analysis");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        const agentResult = await runDiffsAnalysis(snapshotId);
        logger.info("Agent analysis complete, preparing runs", {
            affectedTests: agentResult.affectedTests.length,
        });

        let preparedRuns: PreparedRunInfo[] = [];

        if (agentResult.affectedTests.length > 0) {
            const { branch } = await db.branchSnapshot.findUniqueOrThrow({
                where: { id: snapshotId },
                select: { branch: { select: { applicationId: true, organizationId: true } } },
            });
            const billingService = createBillingService(db);

            const runs = await prepareRuns(
                agentResult.affectedTests.map((t) => t.slug),
                {
                    db,
                    snapshotId,
                    applicationId: branch.applicationId,
                    organizationId: branch.organizationId,
                    billingService,
                },
            );

            preparedRuns = runs.map((r) => ({
                runId: r.runId,
                slug: r.slug,
                architecture: r.architecture,
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
            affectedTests: agentResult.affectedTests.map((t) => ({
                slug: t.slug,
                testName: t.testName,
                reasoning: t.reasoning,
                affectedReason: t.affectedReason,
            })),
            reasoning: agentResult.reasoning,
        };
    } finally {
        clearInterval(heartbeat);
    }
}
