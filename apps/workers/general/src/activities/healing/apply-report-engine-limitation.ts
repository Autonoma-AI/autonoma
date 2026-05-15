import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { QuarantineTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { markActionApplied } from "./mark-applied";
import type { ApplyReportEngineLimitationInput } from "./types";

/**
 * Creates an Issue with kind=engine_limitation scoped to the snapshot and
 * quarantines the test case for this snapshot.
 */
export async function applyReportEngineLimitation(input: ApplyReportEngineLimitationInput): Promise<void> {
    const logger = rootLogger.child({
        name: "applyReportEngineLimitation",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
    });
    logger.info("Applying report_engine_limitation");

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const issue = await db.issue.create({
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

    await updater.apply(new QuarantineTest({ testCaseId: input.testCaseId, issueId: issue.id }));

    await markActionApplied(input.refinementActionId);
    logger.info("report_engine_limitation applied");
}
