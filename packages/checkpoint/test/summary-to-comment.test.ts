import { describe, expect, it } from "vitest";
import type { SnapshotHealthCounts } from "../src/health";
import { buildCheckpointSummary } from "../src/presentation";
import { healthyHeadlineFromSummary, isNoTestsAffected, statsFromSummary } from "../src/summary-to-comment";

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

const NO_APP_ISSUES = { engine: 0, app: 0 };

describe("statsFromSummary", () => {
    it("mirrors the checkpoint test counts and the unresolved-bucket vocabulary", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 10, passing: 7, failing: 2, setupFailed: 1 }),
            openBugCount: 0,
            failingByKind: NO_APP_ISSUES,
        });

        expect(statsFromSummary(summary)).toEqual({
            assigned: 10,
            passed: 7,
            failed: 2,
            setupFailed: 1,
            running: 0,
            runningLabel: "running",
        });
    });

    it("labels the unresolved bucket 'awaiting review' on a stale checkpoint", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 5, running: 5 }),
            openBugCount: 0,
            failingByKind: NO_APP_ISSUES,
        });

        expect(summary.executionState).toBe("stale");
        expect(statsFromSummary(summary).runningLabel).toBe("awaiting review");
    });
});

describe("healthyHeadlineFromSummary", () => {
    it("reports 'no selected tests are affected' when the diffs job completed with nothing to run", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 8, notAffected: 8 }),
            openBugCount: 0,
            failingByKind: NO_APP_ISSUES,
        });

        expect(summary.executionState).toBe("not_started");
        expect(isNoTestsAffected(summary, "completed")).toBe(true);
        expect(healthyHeadlineFromSummary(summary, "completed")).toBe(
            "Autonoma analyzed this change - no selected tests are affected, so there was nothing to run.",
        );
    });

    it("claims no issues only when the checkpoint itself is clean", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 6, passing: 6 }),
            openBugCount: 0,
            failingByKind: NO_APP_ISSUES,
        });

        expect(summary.executionState).toBe("passed");
        expect(healthyHeadlineFromSummary(summary, "completed")).toBe("Autonoma found no issues in this PR.");
    });

    it("never claims no issues while the checkpoint still reports open bugs", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "active",
            counts: counts({ totalTests: 4, passing: 3, failing: 1 }),
            openBugCount: 1,
            failingByKind: { engine: 0, app: 1 },
        });

        expect(healthyHeadlineFromSummary(summary, "completed")).toBe(
            "Autonoma could not complete every selected test in this PR.",
        );
    });

    it("surfaces the checkpoint's in-progress state when it is still running", () => {
        const summary = buildCheckpointSummary({
            snapshotStatus: "processing",
            counts: counts({ totalTests: 3, running: 3 }),
            openBugCount: 0,
            failingByKind: NO_APP_ISSUES,
        });

        expect(summary.executionState).toBe("running");
        expect(healthyHeadlineFromSummary(summary, "processing")).toBe(
            "Autonoma is running the selected tests for this PR.",
        );
    });

    it("falls back to the healthy copy when there is no summary", () => {
        expect(healthyHeadlineFromSummary(undefined, undefined)).toBe("Autonoma found no issues in this PR.");
    });
});
