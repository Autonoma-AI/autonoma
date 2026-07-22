import type { CheckpointPresentationSummary } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { formatCheckpointMetrics } from "./format-checkpoint-metrics";

type Overrides = {
    executionState: CheckpointPresentationSummary["executionState"];
    testCounts?: Partial<CheckpointPresentationSummary["testCounts"]>;
    openBugCount?: number;
    analysis?: CheckpointPresentationSummary["analysis"];
};

function buildSummary(overrides: Overrides): CheckpointPresentationSummary {
    const counts = overrides.testCounts ?? {};
    return {
        tone: "neutral",
        label: "test",
        executionState: overrides.executionState,
        openBugCount: overrides.openBugCount ?? 0,
        issueOccurrenceCount: 0,
        testCounts: {
            assigned: counts.assigned ?? 0,
            run: counts.run ?? 0,
            passed: counts.passed ?? 0,
            failed: counts.failed ?? 0,
            setupFailed: counts.setupFailed ?? 0,
            running: counts.running ?? 0,
            notRun: counts.notRun ?? 0,
        },
        failingByKind: { engine: 0, app: 0 },
        suiteChangeCount: 0,
        analysis: overrides.analysis,
    };
}

describe("formatCheckpointMetrics", () => {
    it("spells out a not-started snapshot", () => {
        const summary = buildSummary({
            executionState: "not_started",
            testCounts: { assigned: 39 },
        });
        expect(formatCheckpointMetrics(summary, 0, 39)).toBe("Not run yet · 39 to run");
    });

    it("labels the unresolved bucket as awaiting review on a stale snapshot", () => {
        const summary = buildSummary({
            executionState: "stale",
            testCounts: { running: 7 },
            openBugCount: 3,
        });
        expect(formatCheckpointMetrics(summary, 0, 39)).toBe("7 awaiting review · 3 bugs");
    });

    it("labels the unresolved bucket as running while the snapshot is processing", () => {
        const summary = buildSummary({
            executionState: "running",
            testCounts: { running: 4 },
        });
        expect(formatCheckpointMetrics(summary, 0, 4)).toBe("4 running");
    });

    it("reports failed and passed counts", () => {
        const summary = buildSummary({
            executionState: "failed",
            testCounts: { failed: 2, passed: 5 },
        });
        expect(formatCheckpointMetrics(summary, 0, 7)).toBe("2 failed · 5 passed");
    });

    it("falls back to the raw bug count when the summary has none", () => {
        const summary = buildSummary({
            executionState: "stale",
            testCounts: { running: 2, passed: 1 },
            openBugCount: 0,
        });
        expect(formatCheckpointMetrics(summary, 2, 5)).toBe("2 awaiting review · 1 passed · 2 bugs");
    });

    it("uses the fallback total when no summary is present", () => {
        expect(formatCheckpointMetrics(undefined, 0, 12)).toBe("12 tests");
    });

    it("reads an authoritative passing checkpoint from its finding buckets", () => {
        const summary = buildSummary({
            executionState: "passed",
            analysis: { jobStatus: "completed", bugCount: 0, passedCount: 5, coverageCount: 0 },
        });
        expect(formatCheckpointMetrics(summary, 0, 5)).toBe("5 passed");
    });

    it("reads an authoritative client-bug checkpoint as bugs, passed, and coverage", () => {
        const summary = buildSummary({
            executionState: "failed",
            analysis: { jobStatus: "completed", bugCount: 1, passedCount: 3, coverageCount: 2 },
        });
        expect(formatCheckpointMetrics(summary, 0, 6)).toBe("1 bug · 3 passed · 2 couldn't confirm");
    });

    it("reads an analyzing authoritative checkpoint as Analyzing", () => {
        const summary = buildSummary({
            executionState: "running",
            analysis: { jobStatus: "running", bugCount: 0, passedCount: 0, coverageCount: 0 },
        });
        expect(formatCheckpointMetrics(summary, 0, 4)).toBe("Analyzing");
    });

    it("reads a failed authoritative job as Analysis failed", () => {
        const summary = buildSummary({
            executionState: "pipeline_failed",
            analysis: { jobStatus: "failed", bugCount: 0, passedCount: 0, coverageCount: 0 },
        });
        expect(formatCheckpointMetrics(summary, 0, 4)).toBe("Analysis failed");
    });

    it("reads an empty completed authoritative report as no tests analyzed", () => {
        const summary = buildSummary({
            executionState: "passed",
            analysis: { jobStatus: "completed", bugCount: 0, passedCount: 0, coverageCount: 0 },
        });
        expect(formatCheckpointMetrics(summary, 0, 0)).toBe("No tests analyzed");
    });
});
