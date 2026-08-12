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
 * This analysis's terminal verdicts, one per covered test. A contained finding with no verdict of its own counts
 * as an `engine_artifact`, so the run never reads smaller than it was queued.
 */
export async function loadFindingCategories(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<string[]> {
    const rows = await db.analysisFinding.findMany({
        where: { reportSnapshotId: snapshotId, ...COVERED_FINDING },
        select: { currentClassification: { select: { category: true } } },
    });
    return rows.map((row) => row.currentClassification?.category ?? ANALYSIS_VERDICT.engine_artifact);
}

export async function readPlaneSummary(
    db: PrismaClient | Prisma.TransactionClient,
    snapshotId: string,
): Promise<RunPlaneSummary> {
    return summarizeCategories(await loadFindingCategories(db, snapshotId));
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
        select: { reportSnapshotId: true, currentClassification: { select: { category: true } } },
    });

    const categoriesBySnapshot = new Map<string, string[]>();
    for (const row of rows) {
        const categories = categoriesBySnapshot.get(row.reportSnapshotId) ?? [];
        categories.push(row.currentClassification?.category ?? ANALYSIS_VERDICT.engine_artifact);
        categoriesBySnapshot.set(row.reportSnapshotId, categories);
    }
    for (const [snapshotId, categories] of categoriesBySnapshot) {
        summaries.set(snapshotId, summarizeCategories(categories));
    }
    return summaries;
}

/** A settled run that judged nothing - Impact Analysis selected no test and authored none. */
export const EMPTY_PLANE_SUMMARY: RunPlaneSummary = summarizeCategories([]);

function summarizeCategories(categories: string[]): RunPlaneSummary {
    const coverage = summarizeVerdictPlanes(categories);
    const bugCount = categories.filter((category) => category === ANALYSIS_VERDICT.client_bug).length;
    return {
        state: deriveAnalysisVerdict({
            bugCount,
            coverageGapCount: coverage.total,
            investigatedCount: categories.length,
        }),
        coverage,
        bugCount,
        passedCount: categories.filter((category) => category === ANALYSIS_VERDICT.passed).length,
        testCount: categories.length,
    };
}
