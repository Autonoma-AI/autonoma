import type { Finding } from "@autonoma/analysis";
import type { GenerationStatus, Prisma, PrismaClient } from "@autonoma/db";
import { type AnalysisRunFinding, type AnalysisRunView, analysisTestOriginSchema } from "@autonoma/types";

const generationSelect = {
    status: true,
    testPlan: { select: { testCaseId: true } },
} satisfies Prisma.TestGenerationSelect;

/**
 * The most recent (non-shadow) generation's status per test case in this snapshot. A test case with no generation
 * yet is absent from the map.
 */
export async function loadLatestGenerationStatuses(
    db: PrismaClient,
    snapshotId: string,
    testCaseIds: string[],
): Promise<Map<string, GenerationStatus>> {
    if (testCaseIds.length === 0) return new Map();
    const generations = await db.testGeneration.findMany({
        where: { snapshotId, shadow: false, testPlan: { testCaseId: { in: testCaseIds } } },
        // Latest-first with `id` as a total-order tiebreak: two generations can share an `updatedAt` millisecond,
        // and without a stable order the winner would flap between polls with the DB's row order.
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: generationSelect,
    });

    const latest = new Map<string, GenerationStatus>();
    for (const generation of generations) {
        const testCaseId = generation.testPlan.testCaseId;
        // Ordered latest-first, so the first row seen for a test case is its latest generation.
        if (!latest.has(testCaseId)) latest.set(testCaseId, generation.status);
    }
    return latest;
}

/** Build the run view: one row per finding with its live status, plus the selection summary counted by origin. */
export function buildAnalysisRunView(findings: Finding[], statuses: Map<string, GenerationStatus>): AnalysisRunView {
    const rows = findings.map((finding): AnalysisRunFinding => {
        const origin = analysisTestOriginSchema.safeParse(finding.origin).data;
        return {
            findingId: finding.findingId,
            testCase: finding.testCase,
            origin,
            selectionReason: finding.selectionReason,
            selfHealed: finding.selfHealed,
            generationStatus: statuses.get(finding.testCase.id),
            verdict:
                finding.current != null
                    ? { category: finding.current.category, headline: finding.current.headline }
                    : undefined,
            contained: finding.failure != null,
        };
    });

    return {
        findings: rows,
        selection: {
            targetCount: rows.length,
            affectedCount: rows.filter((row) => row.origin === "pre_existing").length,
            proposedCount: rows.filter((row) => row.origin === "proposed").length,
        },
    };
}
