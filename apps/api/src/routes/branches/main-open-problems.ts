import { AnalysisStore, type Issue } from "@autonoma/analysis";
import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { compareAnalysisIssues, type MainOpenProblem } from "@autonoma/types";

/**
 * Everything still unresolved on an application's main branch: the open `AnalysisIssue` rows its Reporter left.
 *
 * Issues are branch-scoped and outlive any one run, so this reads the branch rather than main's active snapshot -
 * that pointer moves for reasons unrelated to analysis (a suite edit, an SDK plan upload) and would otherwise
 * empty the list.
 */
export async function loadMainOpenProblems(
    db: PrismaClient,
    applicationId: string,
    organizationId: string,
    parentLogger?: Logger,
): Promise<MainOpenProblem[]> {
    const logger = (parentLogger ?? rootLogger).child({ name: "loadMainOpenProblems" });
    logger.info("Loading main-branch open problems", {
        application: { applicationId },
        organization: { organizationId },
    });

    const application = await db.application.findFirst({
        where: { id: applicationId, organizationId },
        select: { mainBranch: { select: { id: true } } },
    });
    const mainBranch = application?.mainBranch;
    if (mainBranch == null) {
        logger.info("Application has no main branch; nothing can be unresolved on it", {
            application: { applicationId },
        });
        return [];
    }

    const issues = await new AnalysisStore(db).forBranch(mainBranch.id).openIssues();
    const problems = issues.map(toProblem);
    problems.sort(compareProblems);

    logger.info("Loaded main-branch open problems", {
        application: { applicationId },
        branch: { branchId: mainBranch.id },
        extra: { count: problems.length },
    });

    return problems;
}

function toProblem(issue: Issue): MainOpenProblem {
    // Distinct snapshots, not finding rows: one run can attribute several findings to the same issue.
    const runs = new Set(issue.coveredFindings.map((finding) => finding.snapshotId));
    const newestFinding = issue.coveredFindings.reduce<Date | undefined>(
        (newest, finding) => (newest == null || finding.createdAt > newest ? finding.createdAt : newest),
        undefined,
    );

    return {
        id: issue.id,
        title: issue.title,
        kind: issue.kind,
        severity: issue.severity,
        detail: blankToUndefined(issue.actualBehavior),
        occurrences: runs.size,
        // An issue with no surviving findings still has to date from somewhere; its own birth is the honest floor.
        lastSeenAt: newestFinding ?? issue.createdAt,
    };
}

/** Bugs first, then descending severity (the shared issue ordering), then the most recently seen. */
function compareProblems(a: MainOpenProblem, b: MainOpenProblem): number {
    const bySeverity = compareAnalysisIssues(a, b);
    if (bySeverity !== 0) return bySeverity;
    return b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
}

function blankToUndefined(text: string): string | undefined {
    const trimmed = text.trim();
    return trimmed === "" ? undefined : trimmed;
}
