import type { IssueKind, PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { listExecutedTestsForSnapshots, type SnapshotExecutedTest } from "./executed-tests";

export type SnapshotHealth = "healthy" | "critical" | "running" | "unknown";

export interface SnapshotHealthCounts {
    failing: number;
    passing: number;
    running: number;
    /**
     * Tests that never ran because their scenario setup failed. Tracked apart
     * from `failing` so "couldn't run" reads differently from "your code failed
     * N tests", even though both drive the snapshot to `critical`.
     */
    setupFailed: number;
    notAffected: number;
    totalTests: number;
}

/**
 * Engine-vs-app attribution of failing tests that carry a linked Issue, keyed by
 * the Issue kind (`engine_limitation` -> engine; `application_bug` /
 * `unknown_issue` -> app). Reported tests re-run every snapshot and surface here
 * as failures instead of being hidden.
 */
export interface FailingByKind {
    engine: number;
    app: number;
}

export interface SnapshotHealthResult {
    health: SnapshotHealth;
    counts: SnapshotHealthCounts;
    failingByKind: FailingByKind;
}

export function computeSnapshotHealth(snapshotStatus: string, counts: SnapshotHealthCounts): SnapshotHealth {
    // A cancelled snapshot was abandoned (superseded by a newer request); its
    // partial run results are not meaningful health signal.
    if (snapshotStatus === "cancelled") return "unknown";
    if (snapshotStatus === "failed") return "critical";
    // Setup-failed tests yield no trustworthy signal - surface them as critical
    // so the user acts on them, even when nothing genuinely failed.
    if (counts.failing > 0 || counts.setupFailed > 0) return "critical";
    if (counts.running > 0 || snapshotStatus === "processing") return "running";
    if (counts.passing > 0 || counts.notAffected > 0) return "healthy";
    return "unknown";
}

export interface ExecutedTestTally {
    passing: number;
    failing: number;
    setupFailed: number;
    running: number;
}

// The single source of truth for how an executed test's final outcome maps to a
// health/report bucket. Keyed by every `SnapshotExecutedTestFinalOutcome`, so
// adding a new outcome is a typechecker-guarded change here rather than three
// hand-written branches that can silently diverge.
const OUTCOME_BUCKET: Record<SnapshotExecutedTest["finalOutcome"], keyof ExecutedTestTally> = {
    passed: "passing",
    failed: "failing",
    setup_failed: "setupFailed",
    unresolved: "running",
};

/**
 * Tallies executed tests into health/report buckets by final outcome. Shared by
 * both health-count computations and the report-results bucketer so all surfaces
 * agree.
 */
export function tallyExecutedTests(tests: SnapshotExecutedTest[]): ExecutedTestTally {
    const tally: ExecutedTestTally = { passing: 0, failing: 0, setupFailed: 0, running: 0 };
    for (const test of tests) {
        tally[OUTCOME_BUCKET[test.finalOutcome]] += 1;
    }
    return tally;
}

/** The Issue kind linked to an execution, keyed by the generation it reviewed. */
export interface IssueKindsByExecution {
    byGenerationId: Map<string, IssueKind>;
}

/**
 * Splits the failing tests that carry a linked Issue into the engine-vs-app
 * buckets. A test with no linked Issue (or a non-failing outcome) is ignored -
 * the attribution is only meaningful for failures healing has already triaged.
 * The Issue rides the review chain, so it is matched to the specific generation
 * whose review it belongs to.
 */
export function computeFailingByKind(tests: SnapshotExecutedTest[], issueKinds: IssueKindsByExecution): FailingByKind {
    const failingByKind: FailingByKind = { engine: 0, app: 0 };
    for (const test of tests) {
        if (test.finalOutcome !== "failed") continue;
        const kind = test.generationId != null ? issueKinds.byGenerationId.get(test.generationId) : undefined;
        if (kind == null) continue;
        if (kind === "engine_limitation") failingByKind.engine += 1;
        else failingByKind.app += 1;
    }
    return failingByKind;
}

/**
 * Loads the Issue kind for each of the given generations. The Issue -> TestCase
 * link rides the review chain (`generationReviewId`), so this matches on the
 * reviewed generation directly rather than walking back to the snapshot - a
 * shallow, single query the callers batch across every failing test.
 */
export async function loadIssueKindsForExecutions(
    db: PrismaClient,
    generationIds: string[],
): Promise<IssueKindsByExecution> {
    const result: IssueKindsByExecution = { byGenerationId: new Map() };
    if (generationIds.length === 0) return result;

    const issues = await db.issue.findMany({
        where: { generationReview: { is: { generationId: { in: generationIds } } } },
        select: {
            kind: true,
            generationReview: { select: { generationId: true } },
        },
    });

    for (const issue of issues) {
        if (issue.generationReview != null) result.byGenerationId.set(issue.generationReview.generationId, issue.kind);
    }
    return result;
}

/** Collects the generation ids of the failing tests, deduplicated, for the issue-kind lookup. */
export function failingExecutionIds(testsBySnapshot: Iterable<SnapshotExecutedTest[]>): {
    generationIds: string[];
} {
    const generationIds = new Set<string>();
    for (const tests of testsBySnapshot) {
        for (const test of tests) {
            if (test.finalOutcome !== "failed") continue;
            if (test.generationId != null) generationIds.add(test.generationId);
        }
    }
    return { generationIds: [...generationIds] };
}

export async function aggregateSnapshotHealth(
    db: PrismaClient,
    snapshotsWithStatus: Array<{ id: string; status: string }>,
    parentLogger?: Logger,
): Promise<Map<string, SnapshotHealthResult>> {
    const logger = (parentLogger ?? rootLogger).child({ name: "aggregateSnapshotHealth" });
    if (snapshotsWithStatus.length === 0) return new Map();

    const snapshotIds = snapshotsWithStatus.map((s) => s.id);
    logger.info("Aggregating snapshot health", { count: snapshotIds.length });

    const [assignments, executedTestsBySnapshot] = await Promise.all([
        db.testCaseAssignment.findMany({
            where: { snapshotId: { in: snapshotIds } },
            select: { snapshotId: true, testCaseId: true },
        }),
        listExecutedTestsForSnapshots(db, snapshotIds),
    ]);

    const { generationIds } = failingExecutionIds(executedTestsBySnapshot.values());
    const issueKinds = await loadIssueKindsForExecutions(db, generationIds);

    const result = new Map<string, SnapshotHealthResult>();
    for (const snapshot of snapshotsWithStatus) {
        const snapAssignments = assignments.filter((a) => a.snapshotId === snapshot.id);
        const totalTests = snapAssignments.length;

        const executedTests = executedTestsBySnapshot.get(snapshot.id) ?? [];
        const tally = tallyExecutedTests(executedTests);

        const executedCount = tally.passing + tally.failing + tally.setupFailed + tally.running;
        const notAffected = Math.max(totalTests - executedCount, 0);

        const counts: SnapshotHealthCounts = {
            failing: tally.failing,
            passing: tally.passing,
            running: tally.running,
            setupFailed: tally.setupFailed,
            notAffected,
            totalTests,
        };
        result.set(snapshot.id, {
            health: computeSnapshotHealth(snapshot.status, counts),
            counts,
            failingByKind: computeFailingByKind(executedTests, issueKinds),
        });
    }

    return result;
}
