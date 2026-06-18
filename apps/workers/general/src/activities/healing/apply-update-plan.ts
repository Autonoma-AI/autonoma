import { db } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { TestSuiteUpdater, UpdateTest } from "@autonoma/test-updates";
import { markActionApplied } from "./mark-applied";
import type { ApplyUpdatePlanInput } from "./types";

export async function applyUpdatePlan(input: ApplyUpdatePlanInput): Promise<{ planId: string }> {
    const logger = rootLogger.child({
        name: "applyUpdatePlan",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
    });
    logger.info("Applying update_plan");

    // Preserve scenario binding from the previous plan.
    const existing = await db.testCaseAssignment.findUniqueOrThrow({
        where: { snapshotId_testCaseId: { snapshotId: input.snapshotId, testCaseId: input.testCaseId } },
        select: { plan: { select: { scenarioId: true } } },
    });
    const scenarioId = existing.plan?.scenarioId ?? undefined;

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const { planId, generationId } = await updater.apply(
        new UpdateTest({
            testCaseId: input.testCaseId,
            plan: input.newPrompt,
            scenarioId,
        }),
    );
    logger.info("Plan updated and generation queued", { planId, generationId });

    await linkAffectedTestToGeneration(input.snapshotId, input.testCaseId, generationId, logger);

    await markActionApplied(input.refinementActionId);

    return { planId };
}

/**
 * Points the affected test (if any) for this snapshot + test case at the
 * generation just queued for its updated plan, so the UI can render
 * affected -> generation -> run. This is the diffs flow's "Queued for
 * regeneration" link; it used to be set by the first-turn reconciliation tail
 * and now happens at the moment the regeneration is queued.
 *
 * updateMany is a no-op when no AffectedTest row exists (onboarding, or any
 * update_plan on a test that was not flagged affected), so this is safe to call
 * on every update_plan.
 */
async function linkAffectedTestToGeneration(
    snapshotId: string,
    testCaseId: string,
    generationId: string,
    logger: Logger,
): Promise<void> {
    const { count } = await db.affectedTest.updateMany({
        where: { snapshotId, testCaseId },
        data: { generationId },
    });

    if (count > 0) logger.info("Linked affected test to its regeneration", { testCaseId, generationId });
}
