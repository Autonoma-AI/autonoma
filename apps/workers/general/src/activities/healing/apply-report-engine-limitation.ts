import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { markActionApplied } from "./mark-applied";
import type { ApplyReportEngineLimitationInput } from "./types";

/**
 * Creates an Issue with kind=engine_limitation scoped to the snapshot, recording
 * that the engine could not drive this test. The test case stays in the suite
 * and keeps running every snapshot; this action only records why it currently
 * fails, it does not exclude the test from execution.
 */
export async function applyReportEngineLimitation(input: ApplyReportEngineLimitationInput): Promise<void> {
    const logger = rootLogger.child({
        name: "applyReportEngineLimitation",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
    });
    logger.info("Applying report_engine_limitation");

    await db.issue.create({
        data: {
            ...input.reviewLink,
            kind: "engine_limitation",
            severity: input.severity,
            title: input.title,
            description: input.description,
            snapshotId: input.snapshotId,
            organizationId: input.organizationId,
        },
        select: { id: true },
    });

    await markActionApplied(input.refinementActionId);
    logger.info("report_engine_limitation applied");
}
