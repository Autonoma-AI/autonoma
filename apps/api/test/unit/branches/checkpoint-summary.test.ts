import { describe, expect, it } from "vitest";
import { buildCheckpointSummary } from "../../../src/routes/branches/checkpoint-summary";
import type { SnapshotHealthCounts } from "../../../src/routes/branches/snapshot-health";

function counts(overrides: Partial<SnapshotHealthCounts> = {}): SnapshotHealthCounts {
    return {
        failing: 0,
        passing: 0,
        running: 0,
        setupFailed: 0,
        notAffected: 0,
        totalTests: 0,
        ...overrides,
    };
}

describe("buildCheckpointSummary", () => {
    it("reports 'No runs' (neutral) when nothing ran and passes the engine-vs-app split through", () => {
        // Assigned tests, 0 runs, 0 bugs, an engine-attributed failing split from a prior run.
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 63, notAffected: 63 }),
            openBugCount: 0,
            failingByKind: { engine: 27, app: 0 },
        });

        expect(summary.executionState).toBe("not_started");
        expect(summary.tone).toBe("neutral");
        expect(summary.label).toBe("No runs");
        expect(summary.openBugCount).toBe(0);
        expect(summary.failingByKind).toEqual({ engine: 27, app: 0 });
    });

    it("labels unique open bugs and surfaces occurrences separately", () => {
        // 9 unique open bugs across 15 issue occurrences.
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 73, failing: 9, notAffected: 64 }),
            openBugCount: 9,
            issueOccurrenceCount: 15,
            failingByKind: { engine: 0, app: 9 },
        });

        expect(summary.tone).toBe("critical");
        expect(summary.label).toBe("9 bugs");
        expect(summary.reason).toBe("15 occurrences");
        expect(summary.openBugCount).toBe(9);
        expect(summary.issueOccurrenceCount).toBe(15);
    });

    it("surfaces accepted suite changes while execution has not started", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 207, notAffected: 207 }),
            openBugCount: 0,
            failingByKind: { engine: 0, app: 0 },
            suiteChangeCount: 3,
        });

        expect(summary.executionState).toBe("not_started");
        expect(summary.suiteChangeCount).toBe(3);
        expect(summary.reason).toBe("3 suite changes");
    });

    it("treats a failed snapshot as a pipeline failure, not bugs", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "failed",
            counts: counts({ totalTests: 10 }),
            openBugCount: 0,
            failingByKind: { engine: 0, app: 0 },
        });

        expect(summary.executionState).toBe("pipeline_failed");
        expect(summary.tone).toBe("critical");
        expect(summary.label).toBe("Checkpoint failed");
    });

    it("warns (not 0-bug-critical) when a test failed but no bug is filed yet", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 5, failing: 2, passing: 3 }),
            openBugCount: 0,
            failingByKind: { engine: 0, app: 0 },
        });

        expect(summary.executionState).toBe("failed");
        expect(summary.tone).toBe("warning");
        expect(summary.label).toBe("2 failing");
    });

    it("marks pending/running runs on a terminal snapshot as stale", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 4, running: 1, passing: 3 }),
            openBugCount: 0,
            failingByKind: { engine: 0, app: 0 },
        });

        expect(summary.executionState).toBe("stale");
        expect(summary.tone).toBe("warning");
    });

    it("reports running while the snapshot is still processing", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "processing",
            counts: counts({ totalTests: 4, running: 1 }),
            openBugCount: 0,
            failingByKind: { engine: 0, app: 0 },
        });

        expect(summary.executionState).toBe("running");
        expect(summary.tone).toBe("neutral");
    });

    it("reports passing when runs completed successfully", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 4, passing: 4 }),
            openBugCount: 0,
            failingByKind: { engine: 0, app: 0 },
        });

        expect(summary.executionState).toBe("passed");
        expect(summary.tone).toBe("success");
        expect(summary.label).toBe("Passing");
    });
});
