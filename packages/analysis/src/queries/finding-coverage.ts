import { Prisma, type PrismaClient } from "@autonoma/db";
import { ANALYSIS_VERDICT, type RunPlaneSummary, summarizeVerdictPlanes } from "@autonoma/types";
import { deriveAnalysisVerdict } from "../verdict";

/**
 * A crashed investigation counts as covered. The guard that refuses to settle and the counts every surface renders
 * filter on this same value, so a run cannot report coverage the guard never checked.
 */
export const COVERED_FINDING: Prisma.AnalysisFindingWhereInput = {
    OR: [{ currentClassificationId: { not: null } }, { failure: { not: Prisma.DbNull } }],
};

/**
 * The columns the plane summary reads per covered finding: its terminal verdict, plus the identity the distinct-bug
 * tally dedupes on (its attributed branch issue, or the finding itself when unattributed).
 */
const PLANE_FINDING_SELECT = {
    id: true,
    issueId: true,
    currentClassification: { select: { category: true } },
} satisfies Prisma.AnalysisFindingSelect;

type PlaneFindingRow = Prisma.AnalysisFindingGetPayload<{ select: typeof PLANE_FINDING_SELECT }>;

/**
 * One covered finding reduced to what the plane summary counts: the terminal verdict `category`, and the identity a
 * distinct-bug tally keys on - the branch `AnalysisIssue` the Reporter attributed it to, or the finding itself when
 * it has no attribution.
 */
export interface PlaneFinding {
    id: string;
    issueId?: string;
    category: string;
}

/**
 * A contained finding with no verdict of its own counts as an `engine_artifact`, so the run never reads smaller than
 * it was queued.
 */
function toPlaneFinding(row: PlaneFindingRow): PlaneFinding {
    return {
        id: row.id,
        issueId: row.issueId ?? undefined,
        category: row.currentClassification?.category ?? ANALYSIS_VERDICT.engine_artifact,
    };
}

/** This analysis's covered findings, one per covered test, reduced to the {@link PlaneFinding} shape. */
async function loadPlaneFindings(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<PlaneFinding[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId, ...COVERED_FINDING },
        select: PLANE_FINDING_SELECT,
    });
    return rows.map(toPlaneFinding);
}

/** This analysis's terminal verdicts, one per covered test - the category strings the coverage plane counts. */
export async function loadFindingCategories(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<string[]> {
    return (await loadPlaneFindings(db, snapshotId)).map((finding) => finding.category);
}

export async function readPlaneSummary(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<RunPlaneSummary> {
    return summarizeFindings(await loadPlaneFindings(db, snapshotId));
}

/**
 * The same summary for many runs in one query, for the branch's snapshot list and the PR list. A snapshot whose
 * findings are all uncovered is absent from the map; see {@link EMPTY_PLANE_SUMMARY}.
 */
export async function readPlaneSummaries(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotIds: string[],
): Promise<Map<string, RunPlaneSummary>> {
    const summaries = new Map<string, RunPlaneSummary>();
    if (snapshotIds.length === 0) return summaries;

    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: { in: snapshotIds }, ...COVERED_FINDING },
        select: { reportSnapshotId: true, ...PLANE_FINDING_SELECT },
    });

    const findingsBySnapshot = new Map<string, PlaneFinding[]>();
    for (const row of rows) {
        const findings = findingsBySnapshot.get(row.reportSnapshotId) ?? [];
        findings.push(toPlaneFinding(row));
        findingsBySnapshot.set(row.reportSnapshotId, findings);
    }
    for (const [snapshotId, findings] of findingsBySnapshot) {
        summaries.set(snapshotId, summarizeFindings(findings));
    }
    return summaries;
}

/** A settled run that judged nothing - Impact Analysis selected no test and authored none. */
export const EMPTY_PLANE_SUMMARY: RunPlaneSummary = summarizeFindings([]);

export function summarizeFindings(findings: readonly PlaneFinding[]): RunPlaneSummary {
    const categories = findings.map((finding) => finding.category);
    const coverage = summarizeVerdictPlanes(categories);
    const bugCount = countDistinctBugs(findings);
    return {
        state: deriveAnalysisVerdict({
            bugCount,
            coverageGapCount: coverage.total,
            investigatedCount: findings.length,
        }),
        coverage,
        bugCount,
        passedCount: categories.filter((category) => category === ANALYSIS_VERDICT.passed).length,
        testCount: findings.length,
    };
}

/**
 * The DISTINCT bugs this run surfaced, not the `client_bug` findings it filed: many tests can hit one underlying bug,
 * and the Reporter dedupes those findings into one branch `AnalysisIssue`. Count the issues the findings were
 * attributed to, falling back to the finding's own id for any unattributed `client_bug` so it still counts once - the
 * Reporter's dedupe-by-issue, not a per-finding tally. Run-scoped, so it can read below the branch-cumulative report
 * headline when a bug carried from an earlier commit is still open with no `client_bug` finding this run.
 */
function countDistinctBugs(findings: readonly PlaneFinding[]): number {
    const bugs = new Set<string>();
    for (const finding of findings) {
        if (finding.category !== ANALYSIS_VERDICT.client_bug) continue;
        bugs.add(finding.issueId ?? finding.id);
    }
    return bugs.size;
}
