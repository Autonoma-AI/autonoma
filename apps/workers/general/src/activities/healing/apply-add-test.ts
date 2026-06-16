import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { AddTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { markActionApplied } from "./mark-applied";
import type { ApplyAddTestInput } from "./types";

/**
 * Mints a brand-new test for the snapshot: creates a TestCase, its TestPlan, and
 * a TestCaseAssignment, then queues the plan's first generation. Returns the new
 * plan id so the caller can fold it into iteration N+1's analysis scope, exactly
 * like applyUpdatePlan surfaces the plan it minted - the new test then enters the
 * next iteration's generate/run/review cycle.
 */
export async function applyAddTest(input: ApplyAddTestInput): Promise<{ planId: string }> {
    const logger = rootLogger.child({
        name: "applyAddTest",
        snapshotId: input.snapshotId,
        folderId: input.folderId,
    });
    logger.info("Applying add_test", { name: input.name });

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const { planId } = await updater.apply(
        new AddTest({
            name: input.name,
            plan: input.instruction,
            folderId: input.folderId,
            scenarioId: input.scenarioId,
        }),
    );
    logger.info("Test added and generation queued", { planId });

    await markActionApplied(input.refinementActionId);

    return { planId };
}
