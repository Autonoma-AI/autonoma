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
        const analysisResult = await runDiffsAnalysis(snapshotId);

        const combinedAffectedTestsBySlug = new Map(
            analysisResult.importedAffectedTests.map((t) => [t.slug, t] as const),
        );
        for (const t of analysisResult.affectedTests) {
            if (!combinedAffectedTestsBySlug.has(t.slug)) {
                combinedAffectedTestsBySlug.set(t.slug, t);
            }
        }
        const combinedAffectedTests = Array.from(combinedAffectedTestsBySlug.values());

        logger.info("Agent analysis complete, preparing runs", {
            agentAffectedTests: analysisResult.affectedTests.length,
            importedAffectedTests: analysisResult.importedAffectedTests.length,
            combined: combinedAffectedTests.length,
        });

        let preparedRuns: PreparedRunInfo[] = [];

        if (combinedAffectedTests.length > 0) {
            const { branch } = await db.branchSnapshot.findUniqueOrThrow({
                where: { id: snapshotId },
                select: { branch: { select: { applicationId: true, organizationId: true } } },
            });
            const billingService = createBillingService(db);

            const runs = await prepareRuns(
                combinedAffectedTests.map((t) => t.slug),
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
            reasoning: analysisResult.reasoning.slice(0, 200),
        });

        return {
            preparedRuns,
            testCandidates: analysisResult.testCandidates,
            affectedTests: combinedAffectedTests.map((t) => ({
                slug: t.slug,
                testName: t.testName,
                reasoning: t.reasoning,
                affectedReason: t.affectedReason,
            })),
            reasoning: analysisResult.reasoning,
        };
    } finally {
        clearInterval(heartbeat);
    }
}
