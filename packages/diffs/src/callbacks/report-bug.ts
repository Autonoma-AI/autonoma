import type { PrismaClient } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import type { BugLinker } from "@autonoma/review";
import type { ReportedBug } from "../tools/report-bug-tool";

interface ReportBugDeps {
    db: PrismaClient;
    bugLinker: BugLinker;
    branchId: string;
    applicationId: string;
    organizationId: string;
}

export async function reportBug(
    bug: ReportedBug,
    { db, bugLinker, branchId, applicationId, organizationId }: ReportBugDeps,
): Promise<void> {
    logger.info("Reporting bug found in diff resolution", {
        runId: bug.runId,
        slug: bug.slug,
        summary: bug.summary,
    });

    const testCase = await db.testCase.findFirst({
        where: { slug: bug.slug, applicationId },
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

    await db.$transaction(async (tx) => {
        await bugLinker.recordBugFromRunReview(tx, {
            runReviewId: runReview.id,
            title: bug.summary,
            description: buildBugDescription(bug),
            severity: "medium",
            confidence: 100,
            category: "application_bug",
            branchId,
            testCaseId: testCase.id,
            organizationId,
        });
    });
}

function buildBugDescription(bug: ReportedBug): string {
    const sections = [bug.details];
    if (bug.affectedFiles.length > 0) {
        sections.push(`## Affected files\n${bug.affectedFiles.map((f) => `- ${f}`).join("\n")}`);
    }
    sections.push(`## Suggested fix\n${bug.fixPrompt}`);
    return sections.join("\n\n");
}
