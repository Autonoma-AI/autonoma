import type { Finding } from "@autonoma/analysis";
import type { GenerationStatus, Prisma, PrismaClient } from "@autonoma/db";
import type { SuiteChange } from "@autonoma/test-suite";
import {
    type AnalysisRunFinding,
    type AnalysisRunView,
    type AnalysisSuiteChangeKind,
    analysisTestOriginSchema,
    isTerminalGenerationStatus,
} from "@autonoma/types";

const generationSelect = {
    status: true,
    createdAt: true,
    updatedAt: true,
    testPlan: { select: { testCaseId: true } },
} satisfies Prisma.TestGenerationSelect;

export interface LatestGeneration {
    status: GenerationStatus;
    startedAt: Date;
    /** Approximated by the row's last write; absent while the generation is still running. */
    completedAt?: Date;
}

/**
 * The most recent generation per test case in this snapshot: its status and timing. A test case with no
 * generation yet is absent from the map.
 */
export async function loadLatestGenerations(
    db: PrismaClient,
    snapshotId: string,
    testCaseIds: string[],
): Promise<Map<string, LatestGeneration>> {
    if (testCaseIds.length === 0) return new Map();
    const generations = await db.testGeneration.findMany({
        where: { snapshotId, testPlan: { testCaseId: { in: testCaseIds } } },
        // Latest-first with `id` as a total-order tiebreak: two generations can share an `updatedAt` millisecond,
        // and without a stable order the winner would flap between polls with the DB's row order.
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        select: generationSelect,
    });

    const latest = new Map<string, LatestGeneration>();
    for (const generation of generations) {
        const testCaseId = generation.testPlan.testCaseId;
        // Ordered latest-first, so the first row seen for a test case is its latest generation.
        if (latest.has(testCaseId)) continue;
        latest.set(testCaseId, {
            status: generation.status,
            startedAt: generation.createdAt,
            completedAt: isTerminalGenerationStatus(generation.status) ? generation.updatedAt : undefined,
        });
    }
    return latest;
}

/**
 * Build the run view: one row per finding with its live status, timing and suite-change kind, the PR-removed
 * tests that never got a finding, and the selection summary counted by origin.
 */
export function buildAnalysisRunView(
    findings: Finding[],
    generations: Map<string, LatestGeneration>,
    suiteChanges: SuiteChange[],
): AnalysisRunView {
    const changeByTestCase = new Map(suiteChanges.map((change) => [change.testCaseId, change]));

    const rows = findings.map((finding): AnalysisRunFinding => {
        const origin = analysisTestOriginSchema.safeParse(finding.origin).data;
        const generation = generations.get(finding.testCase.id);
        return {
            findingId: finding.findingId,
            testCase: finding.testCase,
            origin,
            selectionReason: finding.selectionReason,
            selfHealed: finding.selfHealed,
            generationStatus: generation?.status,
            verdict:
                finding.current != null
                    ? { category: finding.current.category, headline: finding.current.headline }
                    : undefined,
            contained: finding.failure != null,
            change: changeKindOf(changeByTestCase.get(finding.testCase.id)),
            startedAt: generation?.startedAt,
            completedAt: generation?.completedAt,
        };
    });

    const foundTestCaseIds = new Set(findings.map((finding) => finding.testCase.id));
    const removedTests = suiteChanges.flatMap((change) =>
        change.type === "removed" && !foundTestCaseIds.has(change.testCaseId)
            ? [
                  {
                      testCase: { id: change.testCaseId, name: change.testCaseName, slug: change.testCaseSlug },
                      previousPlan: change.previousPlan,
                  },
              ]
            : [],
    );

    return {
        findings: rows,
        removedTests,
        selection: {
            targetCount: rows.length,
            affectedCount: rows.filter((row) => row.origin === "pre_existing").length,
            proposedCount: rows.filter((row) => row.origin === "proposed").length,
        },
    };
}

function changeKindOf(change: SuiteChange | undefined): AnalysisSuiteChangeKind | undefined {
    if (change == null) return undefined;
    switch (change.type) {
        case "added":
            return "created";
        case "updated":
            return "edited";
        case "removed":
            return "removed";
    }
}
