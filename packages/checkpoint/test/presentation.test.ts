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
    it("reports 'No runs' (neutral) when nothing ran", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 63, notAffected: 63 }),
        });

        expect(summary.executionState).toBe("not_started");
        expect(summary.tone).toBe("neutral");
        expect(summary.label).toBe("No runs");
    });

    it("surfaces accepted suite changes while execution has not started", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 207, notAffected: 207 }),
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
        });

        expect(summary.executionState).toBe("pipeline_failed");
        expect(summary.tone).toBe("critical");
        expect(summary.label).toBe("Checkpoint failed");
    });

    it("warns when a test failed", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 5, failing: 2, passing: 3 }),
        });

        expect(summary.executionState).toBe("failed");
        expect(summary.tone).toBe("warning");
        expect(summary.label).toBe("2 failing");
    });

    it("counts setup failures alongside the failing ones", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 5, failing: 2, setupFailed: 1, passing: 2 }),
        });

        expect(summary.label).toBe("3 failing");
    });

    it("names setup failures as such when nothing else failed", () => {
        // The environment never came up, so no test got a chance to fail on its merits - saying "1 failing"
        // here would read as a claim about the application.
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 4, setupFailed: 1, passing: 3 }),
        });

        expect(summary.executionState).toBe("failed");
        expect(summary.tone).toBe("warning");
        expect(summary.label).toBe("1 setup failed");
    });

    it("marks pending/running runs on a terminal snapshot as stale", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 4, running: 1, passing: 3 }),
        });

        expect(summary.executionState).toBe("stale");
        expect(summary.tone).toBe("warning");
    });

    it("reports running while the snapshot is still processing", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "processing",
            counts: counts({ totalTests: 4, running: 1 }),
        });

        expect(summary.executionState).toBe("running");
        expect(summary.tone).toBe("neutral");
    });

    it("reports passing when runs completed successfully", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 4, passing: 4 }),
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
        expect(summary.analysis?.bugCount).toBe(2);
    });

    it("labels a single client bug in the singular", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 1, passed: 0, coverage: 0 },
        });

        expect(summary.label).toBe("1 bug");
    });

    it("reads a coverage-only checkpoint as 'Not confirmed' - not green, and not red either", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 0, passed: 0, coverage: 3 },
        });

        // Three tests were selected and not one of them confirmed anything about the app. Warning rather than
        // critical: the PR is not proven broken, our harness failed to exercise it.
        expect(summary.tone).toBe("warning");
        expect(summary.label).toBe("Not confirmed");
        expect(summary.reason).toBe("3 blocked");
        expect(summary.executionState).toBe("not_started");
    });

    it("reads a partially-confirmed checkpoint as 'Not confirmed' (amber) - a coverage gap is not verified", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 0, passed: 4, coverage: 2 },
        });

        // A coverage gap of any kind means the change was not fully confirmed, so this is NOT green even though most
        // of the suite passed - "no bug" is not "verified". Amber (warning), with the unconfirmed count as a reason,
        // and `not_started` so the derived health reads `unknown`, never `healthy`.
        expect(summary.tone).toBe("warning");
        expect(summary.label).toBe("Not confirmed");
        expect(summary.reason).toBe("2 couldn't confirm");
        expect(summary.executionState).toBe("not_started");
    });

    it("distinguishes a run that selected nothing from one that confirmed nothing", () => {
        const summary = buildAuthoritativeCheckpointSummary({
            jobStatus: "completed",
            findingBuckets: { bug: 0, passed: 0, coverage: 0 },
            totalTests: 12,
        });

        // Nothing to check is a quiet outcome, not a passing one - and it is a different thing to tell the reader
        // than "we tried twelve and got nothing back".
        expect(summary.tone).toBe("neutral");
        expect(summary.label).toBe("No tests affected");
        expect(summary.reason).toBeUndefined();
        expect(summary.executionState).toBe("not_started");
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
