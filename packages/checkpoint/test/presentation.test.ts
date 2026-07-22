import { describe, expect, it } from "vitest";
import type { SnapshotHealthCounts } from "../src/health";
import { buildAuthoritativeCheckpointSummary, buildCheckpointSummary } from "../src/presentation";

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

describe("buildAuthoritativeCheckpointSummary", () => {
    it("reads a passing authoritative checkpoint as Passing (green), never stale", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 0, passed: 5, coverage: 0 },
            totalTests: 5,
        });

        expect(summary.tone).toBe("success");
        expect(summary.label).toBe("Passing");
        expect(summary.executionState).toBe("passed");
        expect(summary.reason).toBeUndefined();
        expect(summary.analysis).toEqual({ jobStatus: "completed", bugCount: 0, passedCount: 5, coverageCount: 0 });
    });

    it("reads a client-bug authoritative checkpoint as 'N bugs' (red), counting client_bug findings", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 2, passed: 3, coverage: 1 },
            totalTests: 6,
        });

        expect(summary.tone).toBe("critical");
        expect(summary.label).toBe("2 bugs");
        expect(summary.openBugCount).toBe(2);
        expect(summary.analysis?.bugCount).toBe(2);
    });

    it("labels a single client bug in the singular", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 1, passed: 0, coverage: 0 },
        });

        expect(summary.label).toBe("1 bug");
    });

    it("does not turn a coverage-only checkpoint red or awaiting-triage", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 0, passed: 0, coverage: 3 },
        });

        expect(summary.tone).toBe("success");
        expect(summary.label).toBe("Passing");
        expect(summary.reason).toBe("3 couldn't confirm");
    });

    it("reads a running job (no report yet) as Analyzing (neutral)", () => {
        const summary = buildAuthoritativeCheckpointSummary({ jobStatus: "running" });

        expect(summary.tone).toBe("neutral");
        expect(summary.label).toBe("Analyzing");
        expect(summary.executionState).toBe("running");
        expect(summary.analysis?.jobStatus).toBe("running");
    });

    it("treats a completed job with no report yet as still analyzing", () => {
        const summary = buildAuthoritativeCheckpointSummary({ jobStatus: "completed" });

        expect(summary.tone).toBe("neutral");
        expect(summary.label).toBe("Analyzing");
    });

    it("reads a failed analysis job as a pipeline failure", () => {
        const summary = buildAuthoritativeCheckpointSummary({ jobStatus: "failed" });

        expect(summary.tone).toBe("critical");
        expect(summary.label).toBe("Checkpoint failed");
        expect(summary.reason).toBe("pipeline error");
        expect(summary.executionState).toBe("pipeline_failed");
    });
});
