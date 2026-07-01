import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { markActionApplied } from "./mark-applied";
import type { ApplyReportUnknownIssueInput } from "./types";

/**
 * Creates an Issue with kind=unknown_issue scoped to the snapshot. Modeled
 * exactly like report_engine_limitation: no customer-facing Bug, no
 * dedup/aggregation, and the Issue lives and dies with its snapshot. This is the
 * downgrade target for a suspected application bug whose cause the healing agent
 * could not re-ground in the checked-out code. The test case stays in the suite
 * and keeps running every snapshot; this action only records why it currently
 * fails, it does not exclude the test from execution.
 */
export async function applyReportUnknownIssue(input: ApplyReportUnknownIssueInput): Promise<void> {
    const logger = rootLogger.child({
        name: "applyReportUnknownIssue",
        snapshotId: input.snapshotId,
        testCaseId: input.testCaseId,
    });
    logger.info("Applying report_unknown_issue");

    await db.issue.create({
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

    await markActionApplied(input.refinementActionId);
    logger.info("report_unknown_issue applied");
}
