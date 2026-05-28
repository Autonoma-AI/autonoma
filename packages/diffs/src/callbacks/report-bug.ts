import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { QuarantineTest, type TestSuiteUpdater } from "@autonoma/test-updates";
import type { ReportedBug } from "../agents/resolution/tools/report-bug-tool";

interface ReportBugDeps {
    db: PrismaClient;
    updater: TestSuiteUpdater;
}

/**
 * Records a bug surfaced by the diff resolution agent. Creates a Bug
 * (no deduplication - one Bug per call) and a linked Issue, then
 * quarantines the test case.
 */
export async function reportBug(bug: ReportedBug, { db, updater }: ReportBugDeps): Promise<void> {
    logger.info("Reporting bug found in diff resolution", {
        runId: bug.runId,
        slug: bug.slug,
        summary: bug.summary,
    });

    const testCase = await db.testCase.findFirst({
        where: { slug: bug.slug, applicationId: updater.applicationId },
        select: { id: true },
    });

    if (testCase == null) {
        logger.warn("Test case not found for reported bug", { slug: bug.slug });
        return;
    }

    const runReview = await db.runReview.findUnique({
        where: { runId: bug.runId },
        select: { id: true },
    });

    if (runReview == null) {
        logger.warn("Run review not found for reported bug", { runId: bug.runId });
        return;
    }

    const issueId = await db.$transaction(async (tx) => {
        const created = await tx.bug.create({
            data: {
                title: bug.summary,
                description: buildBugDescription(bug),
                severity: "medium",
                applicationId: updater.applicationId,
                organizationId: updater.organizationId,
                evidence: {
                    create: { testCaseId: testCase.id },
                },
            },
            select: { id: true },
        });

        const issue = await tx.issue.create({
            data: {
                runReviewId: runReview.id,
                kind: "application_bug",
                severity: "medium",
                title: bug.summary,
                description: buildBugDescription(bug),
                bugId: created.id,
                organizationId: updater.organizationId,
            },
            select: { id: true },
        });

        return issue.id;
    });

    await updater.apply(new QuarantineTest({ testCaseId: testCase.id, issueId }));
}

function buildBugDescription(bug: ReportedBug): string {
    const sections = [bug.details];
    if (bug.affectedFiles.length > 0) {
        sections.push(`## Affected files\n${bug.affectedFiles.map((f) => `- ${f}`).join("\n")}`);
    }
    sections.push(`## Suggested fix\n${bug.fixPrompt}`);
    return sections.join("\n\n");
}
