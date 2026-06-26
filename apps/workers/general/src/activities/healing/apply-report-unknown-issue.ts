import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { QuarantineTest, TestSuiteUpdater } from "@autonoma/test-updates";
import { markActionApplied } from "./mark-applied";
import type { ApplyReportUnknownIssueInput } from "./types";

/**
 * Creates an Issue with kind=unknown_issue scoped to the snapshot and
 * quarantines the test case for this snapshot. Modeled exactly like
 * report_engine_limitation: no customer-facing Bug, no dedup/aggregation, and
 * the Issue lives and dies with its snapshot. This is the downgrade target for
 * a suspected application bug whose cause the healing agent could not re-ground
 * in the checked-out code.
 */
export async function applyReportUnknownIssue(input: ApplyReportUnknownIssueInput): Promise<void> {
    const logger = rootLogger.child({
        name: "applyReportUnknownIssue",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
    });
    logger.info("Applying report_unknown_issue");

    const updater = await TestSuiteUpdater.continueUpdateBySnapshot({
        db,
        snapshotId: input.snapshotId,
        organizationId: input.organizationId,
    });

    const issue = await db.issue.create({
        data: {
            ...input.reviewLink,
            kind: "unknown_issue",
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
    logger.info("report_unknown_issue applied");
}
