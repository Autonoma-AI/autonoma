import { createBillingService } from "@autonoma/billing";
import { db } from "@autonoma/db";
import { type AffectedTestSpec, prepareRuns } from "@autonoma/diffs/prepare-runs";
import { runDiffsAnalysis } from "@autonoma/job-diffs/run";
import { logger as rootLogger } from "@autonoma/logger";
import type { AnalyzeDiffsInput, AnalyzeDiffsOutput, PreparedRunInfo } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function analyzeDiffs({ snapshotId }: AnalyzeDiffsInput): Promise<AnalyzeDiffsOutput> {
    const logger = rootLogger.child({ name: "analyzeDiffs", snapshotId });
    logger.info("Starting diffs analysis");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await db.diffsJob.update({
            where: { snapshotId },
            data: { status: "analyzing", startedAt: new Date() },
        });

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

        logger.info("Agent analysis complete, persisting state and preparing runs", {
            agentAffectedTests: analysisResult.affectedTests.length,
            importedAffectedTests: analysisResult.importedAffectedTests.length,
            combined: combinedAffectedTests.length,
            testCandidates: analysisResult.testCandidates.length,
        });

        const { branch } = await db.branchSnapshot.findUniqueOrThrow({
            where: { id: snapshotId },
            select: { branch: { select: { applicationId: true, organizationId: true } } },
        });

        await persistTestCandidates(snapshotId, branch.organizationId, analysisResult.testCandidates);

        let preparedRunInfos: PreparedRunInfo[] = [];

        if (combinedAffectedTests.length > 0) {
            const billingService = createBillingService(db);
            const specs: AffectedTestSpec[] = combinedAffectedTests.map((t) => ({
                slug: t.slug,
                affectedReason: t.affectedReason,
                reasoning: t.reasoning,
            }));

            const runs = await prepareRuns(specs, {
                db,
                snapshotId,
                applicationId: branch.applicationId,
                organizationId: branch.organizationId,
                billingService,
            });

            preparedRunInfos = runs.map((r) => ({
                runId: r.runId,
                slug: r.slug,
                architecture: r.architecture,
                scenarioId: r.scenarioId,
            }));
        }

        await db.diffsJob.update({
            where: { snapshotId },
            data: {
                analysisReasoning: analysisResult.reasoning,
                status: "replaying",
            },
        });

        logger.info("Diffs analysis activity completed", {
            preparedRuns: preparedRunInfos.length,
            reasoning: analysisResult.reasoning.slice(0, 200),
        });

        return { replays: preparedRunInfos };
    } catch (error) {
        await db.diffsJob.update({
            where: { snapshotId },
            data: {
                status: "failed",
                failureReason: error instanceof Error ? error.message : String(error),
                completedAt: new Date(),
            },
        });
        throw error;
    } finally {
        clearInterval(heartbeat);
    }
}

async function persistTestCandidates(
    snapshotId: string,
    organizationId: string,
    candidates: { name: string; instruction: string; reasoning: string }[],
): Promise<void> {
    if (candidates.length === 0) return;

    await db.testCandidate.createMany({
        data: candidates.map((c) => ({
            snapshotId,
            organizationId,
            name: c.name,
            instruction: c.instruction,
            reasoning: c.reasoning,
        })),
    });
}
