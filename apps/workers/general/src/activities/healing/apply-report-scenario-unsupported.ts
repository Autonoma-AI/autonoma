import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { markActionApplied } from "./mark-applied";
import type { ApplyReportScenarioUnsupportedInput } from "./types";

/**
 * Handles a test that is impossible given the current scenario data (a true data
 * gap, not a stale plan). Unlike the other report_* actions - which keep the test
 * running so a later fix is observed - a scenario_unsupported test can never pass
 * until a human extends the scenario data AND re-authors the test, and the
 * platform never authors scenarios. Re-running it every snapshot would just emit
 * the same failure forever, so this action **removes the test from the suite**
 * (drops its assignment for this snapshot, like remove_test) while recording a
 * Bug-less, snapshot-scoped Issue whose description carries the proposed scenario
 * extension as prose - the human's path to extend the scenario and re-add the
 * test.
 *
 * The Issue and the assignment removal are wrapped in one transaction so the
 * failure record and the deletion are all-or-nothing. Deleting the assignment is
 * safe for the Issue: TestGeneration (the source of a scenario_unsupported
 * verdict - it is generation-only) hangs off the snapshot and plan, not the
 * assignment, so the generation review the Issue links to survives.
 */
export async function applyReportScenarioUnsupported(input: ApplyReportScenarioUnsupportedInput): Promise<void> {
    const logger = rootLogger.child({
        name: "applyReportScenarioUnsupported",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
    });
    logger.info("Applying report_scenario_unsupported");

    await db.$transaction(async (tx) => {
        await tx.issue.create({
            data: {
                ...input.reviewLink,
                kind: "scenario_unsupported",
                severity: input.severity,
                title: input.title,
                description: input.description,
                snapshotId: input.snapshotId,
                organizationId: input.organizationId,
            },
            select: { id: true },
        });

        // Remove the test from this snapshot: it cannot pass until a human acts on
        // the proposed extension, so keeping it in the suite only re-emits the
        // failure. The Issue above preserves the record and the proposed extension.
        await tx.testCaseAssignment.delete({
            where: { snapshotId_testCaseId: { snapshotId: input.snapshotId, testCaseId: input.testCaseId } },
        });
    });

    await markActionApplied(input.refinementActionId);
    logger.info("report_scenario_unsupported applied (issue recorded, test removed from suite)");
}
