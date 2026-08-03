import { hasBranchRunAnalysis } from "@autonoma/checkpoint";
import type { Prisma, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import {
    analysisIssueKindSchema,
    analysisIssueSeveritySchema,
    compareAnalysisIssues,
    type MainOpenProblem,
    type MainOpenProblems,
} from "@autonoma/types";

/** The columns a legacy `Bug` row contributes to the normalized problem. */
const legacyBugSelect = {
    id: true,
    title: true,
    description: true,
    severity: true,
    lastSeenAt: true,
    _count: { select: { issues: true } },
} satisfies Prisma.BugSelect;

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

type LegacyBugRow = Prisma.BugGetPayload<{ select: typeof legacyBugSelect }>;
type OpenIssueRow = Prisma.AnalysisIssueGetPayload<{ select: typeof openIssueSelect }>;

/**
 * Everything still unresolved on an application's main branch, from whichever store owns that application's main.
 *
 * This is the ONE place the legacy-vs-authoritative choice is made for main's problems, so the overview rail and
 * the main-branch page cannot contradict each other. An application whose main has run the merged pipeline reads its
 * `AnalysisIssue` rows; one that has not keeps reading its deprecated `Bug` rows, and flips on its first
 * main-branch analysis run - once, permanently, which is the whole migration.
 *
 * The gate is {@link hasBranchRunAnalysis} over the branch, deliberately NOT over main's active snapshot: issues are
 * branch-scoped and outlive any one run, while the active pointer moves for reasons that have nothing to do with
 * analysis (a suite edit, an SDK plan upload), each of which would otherwise revert this surface to the legacy store
 * and hide the issues the pipeline filed.
 *
 * The legacy arm is every bug that is not `resolved` - `regressed` is unresolved by definition, and deriving the
 * filter from the one terminal status means a new `BugStatus` cannot silently drop out of the list.
 */
export async function loadMainOpenProblems(
    db: PrismaClient,
    applicationId: string,
    organizationId: string,
    parentLogger?: Logger,
): Promise<MainOpenProblems> {
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
        return { source: "legacy_bug", problems: [] };
    }

    const authoritative = await hasBranchRunAnalysis(db, organizationId, mainBranch.id, logger);

    const problems = authoritative
        ? await analysisProblems(db, mainBranch.id, organizationId, logger)
        : await legacyProblems(db, mainBranch.id, organizationId);

    problems.sort(compareProblems);

    logger.info("Loaded main-branch open problems", {
        application: { applicationId },
        branch: { branchId: mainBranch.id },
        extra: { source: authoritative ? "analysis_issue" : "legacy_bug", count: problems.length },
    });

    return { source: authoritative ? "analysis_issue" : "legacy_bug", problems };
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

/** The unresolved legacy bugs on main - the pre-analysis view, unchanged. */
async function legacyProblems(db: PrismaClient, branchId: string, organizationId: string): Promise<MainOpenProblem[]> {
    const bugs = await db.bug.findMany({
        where: { branchId, organizationId, status: { not: "resolved" } },
        select: legacyBugSelect,
    });

    return bugs.map(toLegacyProblem);
}

function toLegacyProblem(bug: LegacyBugRow): MainOpenProblem {
    return {
        id: bug.id,
        title: bug.title,
        // A `Bug` row is an application bug by construction; the other kinds only exist in the analysis taxonomy.
        kind: "bug",
        severity: bug.severity,
        detail: blankToUndefined(bug.description),
        occurrences: bug._count.issues,
        lastSeenAt: bug.lastSeenAt,
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
