import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger as rootLogger } from "@autonoma/logger";
import { countTestsBySnapshot } from "./assigned-tests";
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

/** Per-snapshot health and counts for a batch, in a fixed number of `IN`-scoped queries. */
export async function aggregateSnapshotHealth(
    db: PrismaClient,
    snapshotsWithStatus: Array<{ id: string; status: string }>,
    parentLogger?: Logger,
): Promise<Map<string, SnapshotHealthResult>> {
    const logger = (parentLogger ?? rootLogger).child({ name: "aggregateSnapshotHealth" });
    if (snapshotsWithStatus.length === 0) return new Map();

    const snapshotIds = snapshotsWithStatus.map((s) => s.id);
    logger.info("Aggregating snapshot health", { count: snapshotIds.length });

    // Counted, not listed. Only the per-snapshot TOTAL is used below, and fetching the rows to take their length
    // pulled ~10k of them across a 300-pull-request list - then re-scanned the whole array once per snapshot.
    const [testCountBySnapshot, executedTestsBySnapshot] = await Promise.all([
        countTestsBySnapshot(db, snapshotIds),
        listExecutedTestsForSnapshots(db, snapshotIds),
    ]);

    const result = new Map<string, SnapshotHealthResult>();
    for (const snapshot of snapshotsWithStatus) {
        const totalTests = testCountBySnapshot.get(snapshot.id) ?? 0;

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
        });
    }

    return result;
}
