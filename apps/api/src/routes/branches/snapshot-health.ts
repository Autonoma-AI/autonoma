import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { listExecutedTestsForSnapshots, type SnapshotExecutedTest } from "./snapshot-executed-tests";

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
    quarantined: number;
    notAffected: number;
    totalTests: number;
}

export interface SnapshotHealthResult {
    health: SnapshotHealth;
    counts: SnapshotHealthCounts;
}

export function computeSnapshotHealth(snapshotStatus: string, counts: SnapshotHealthCounts): SnapshotHealth {
    // A cancelled snapshot was abandoned (superseded by a newer request); its
    // partial run results are not meaningful health signal.
    if (snapshotStatus === "cancelled") return "unknown";
    if (snapshotStatus === "failed") return "critical";
    // Setup-failed tests yield no trustworthy signal - surface them as critical
    // so the user acts on them, even when nothing genuinely failed.
    if (counts.failing > 0 || counts.quarantined > 0 || counts.setupFailed > 0) return "critical";
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
 * Tallies executed tests into health/report buckets by final outcome, skipping
 * any quarantined test case. Shared by both health-count computations and the
 * report-results bucketer so all surfaces agree.
 */
export function tallyExecutedTests(tests: SnapshotExecutedTest[], quarantinedSet: Set<string>): ExecutedTestTally {
    const tally: ExecutedTestTally = { passing: 0, failing: 0, setupFailed: 0, running: 0 };
    for (const test of tests) {
        if (quarantinedSet.has(test.testCase.id)) continue;
        tally[OUTCOME_BUCKET[test.finalOutcome]] += 1;
    }
    return tally;
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
            select: { snapshotId: true, testCaseId: true, quarantineIssueId: true },
        }),
        listExecutedTestsForSnapshots(db, snapshotIds),
    ]);

    const result = new Map<string, SnapshotHealthResult>();
    for (const snapshot of snapshotsWithStatus) {
        const snapAssignments = assignments.filter((a) => a.snapshotId === snapshot.id);
        const totalTests = snapAssignments.length;

        const quarantinedSet = new Set<string>();
        for (const a of snapAssignments) {
            if (a.quarantineIssueId != null) quarantinedSet.add(a.testCaseId);
        }

        const executedTests = executedTestsBySnapshot.get(snapshot.id) ?? [];
        const tally = tallyExecutedTests(executedTests, quarantinedSet);

        const quarantined = quarantinedSet.size;
        const replayed = tally.passing + tally.failing + tally.setupFailed + tally.running;
        const notAffected = Math.max(totalTests - quarantined - replayed, 0);

        const counts: SnapshotHealthCounts = {
            failing: tally.failing,
            passing: tally.passing,
            running: tally.running,
            setupFailed: tally.setupFailed,
            quarantined,
            notAffected,
            totalTests,
        };
        result.set(snapshot.id, {
            health: computeSnapshotHealth(snapshot.status, counts),
            counts,
        });
    }

    return result;
}
