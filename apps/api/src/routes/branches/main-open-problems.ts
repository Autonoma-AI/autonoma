import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    analysisIssueKindSchema,
    analysisIssueSeveritySchema,
    compareAnalysisIssues,
    type MainOpenProblem,
} from "@autonoma/types";

/**
 * The columns an open `AnalysisIssue` contributes. The covered findings carry the recurrence pair: how many
 * distinct runs attributed the issue, and when the newest of them ran.
 */
const openIssueSelect = {
    id: true,
    title: true,
    kind: true,
    severity: true,
    actualBehavior: true,
    createdAt: true,
    findings: { select: { reportSnapshotId: true, createdAt: true } },
} satisfies Prisma.AnalysisIssueSelect;

type OpenIssueRow = Prisma.AnalysisIssueGetPayload<{ select: typeof openIssueSelect }>;

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

    const problems = await analysisProblems(db, mainBranch.id, organizationId, logger);
    problems.sort(compareProblems);

    logger.info("Loaded main-branch open problems", {
        application: { applicationId },
        branch: { branchId: mainBranch.id },
        extra: { count: problems.length },
    });

    return problems;
}

/** The open issues on main, as the merged pipeline's Reporter left them. */
async function analysisProblems(
    db: PrismaClient,
    branchId: string,
    organizationId: string,
    logger: Logger,
): Promise<MainOpenProblem[]> {
    const issues = await db.analysisIssue.findMany({
        where: { branchId, organizationId, status: "open" },
        select: openIssueSelect,
    });

    return issues.map((issue) => toAnalysisProblem(issue, logger)).filter((problem) => problem != null);
}

/** One issue row, or nothing when its enum-shaped columns do not parse (never surfaced malformed). */
function toAnalysisProblem(issue: OpenIssueRow, logger: Logger): MainOpenProblem | undefined {
    const kind = analysisIssueKindSchema.safeParse(issue.kind);
    const severity = analysisIssueSeveritySchema.safeParse(issue.severity);
    if (!kind.success || !severity.success) {
        logger.warn("Skipping malformed analysis issue in main's open problems", {
            extra: { issueId: issue.id, kind: issue.kind, severity: issue.severity },
        });
        return undefined;
    }

    // Distinct snapshots, not finding rows: one run can attribute several findings to the same issue.
    const runs = new Set(issue.findings.map((finding) => finding.reportSnapshotId));
    const newestFinding = issue.findings.reduce<Date | undefined>(
        (newest, finding) => (newest == null || finding.createdAt > newest ? finding.createdAt : newest),
        undefined,
    );

    return {
        id: issue.id,
        title: issue.title,
        kind: kind.data,
        severity: severity.data,
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
