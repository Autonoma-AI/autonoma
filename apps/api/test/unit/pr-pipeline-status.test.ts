import type { CheckpointPresentationSummary } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { computePrPipelineStatus } from "../../src/routes/branches/pr-pipeline-status";

const summary: CheckpointPresentationSummary = {
    tone: "success",
    label: "Healthy",
    executionState: "passed",
    openBugCount: 0,
    issueOccurrenceCount: 0,
    testCounts: { assigned: 3, run: 3, passed: 3, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    failingByKind: { engine: 0, app: 0 },
    suiteChangeCount: 0,
};

describe("computePrPipelineStatus", () => {
    it("shows the completed analysis when the preview sits on the analyzed commit", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "abc", summary },
            latestRun: { status: "active", headSha: "abc" },
            previewEnv: { status: "ready", headSha: "abc" },
        });
        expect(status).toEqual({ kind: "checkpoint", summary });
    });

    it("surfaces a build failure that supersedes a completed (green) analysis", () => {
        // The scenario the design targets: a newer commit's preview build failed while the last
        // completed analysis is still green. The failure must win over the stale green result.
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "old", summary },
            latestRun: { status: "active", headSha: "old" },
            previewEnv: { status: "failed", headSha: "new" },
        });
        expect(status).toEqual({ kind: "build_failed" });
    });

    it("shows building while a newer commit's preview is still coming up", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "old", summary },
            latestRun: { status: "active", headSha: "old" },
            previewEnv: { status: "building", headSha: "new" },
        });
        expect(status).toEqual({ kind: "building" });
    });

    it("shows pending_checks when the preview is ready on a newer commit but analysis has not started", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "old", summary },
            latestRun: { status: "active", headSha: "old" },
            previewEnv: { status: "ready", headSha: "new" },
        });
        expect(status).toEqual({ kind: "pending_checks" });
    });

    it("shows analyzing whenever an analysis is in flight, even over a superseding failed preview", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "old", summary },
            latestRun: { status: "processing" },
            previewEnv: { status: "failed", headSha: "new" },
        });
        expect(status).toEqual({ kind: "analyzing" });
    });

    it("works for clients with no preview env: a pending analysis reads as analyzing", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "abc", summary },
            latestRun: { status: "processing" },
        });
        expect(status).toEqual({ kind: "analyzing" });
    });

    it("works for clients with no preview env: an idle branch shows its completed analysis", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "abc", summary },
            latestRun: { status: "active", headSha: "abc" },
        });
        expect(status).toEqual({ kind: "checkpoint", summary });
    });

    it("shows a preview-only PR's build state when no analysis has ever run", () => {
        expect(computePrPipelineStatus({ previewEnv: { status: "building", headSha: "x" } })).toEqual({
            kind: "building",
        });
        expect(computePrPipelineStatus({ previewEnv: { status: "failed", headSha: "x" } })).toEqual({
            kind: "build_failed",
        });
    });

    it("returns none when there is nothing to show", () => {
        expect(computePrPipelineStatus({})).toEqual({ kind: "none" });
    });

    it("does not let an env with an empty head sha falsely supersede a completed analysis", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "abc", summary },
            latestRun: { status: "active", headSha: "abc" },
            previewEnv: { status: "ready", headSha: "" },
        });
        expect(status).toEqual({ kind: "checkpoint", summary });
    });

    it("falls back to none when the analysis is current but its health summary is missing", () => {
        const status = computePrPipelineStatus({
            activeSnapshot: { headSha: "abc", summary: undefined },
            latestRun: { status: "active", headSha: "abc" },
            previewEnv: { status: "ready", headSha: "abc" },
        });
        expect(status).toEqual({ kind: "none" });
    });

    describe("a failed analysis run", () => {
        it("reads as analysis_failed for a client with no preview env, over a stale green checkpoint", () => {
            // The false green this exists to kill: settlement clears the branch's pending pointer, so without the
            // newest-run signal the previous commit's passing summary is all the rollup can see.
            const status = computePrPipelineStatus({
                activeSnapshot: { headSha: "old", summary },
                latestRun: { status: "failed", headSha: "new" },
            });
            expect(status).toEqual({ kind: "analysis_failed" });
        });

        it("reads as analysis_failed when the preview sits on the same commit the run died on", () => {
            const status = computePrPipelineStatus({
                activeSnapshot: { headSha: "old", summary },
                latestRun: { status: "failed", headSha: "new" },
                previewEnv: { status: "ready", headSha: "new" },
            });
            expect(status).toEqual({ kind: "analysis_failed" });
        });

        it("goes stale once a newer commit deploys: the preview's state wins", () => {
            const status = computePrPipelineStatus({
                activeSnapshot: { headSha: "old", summary },
                latestRun: { status: "failed", headSha: "middle" },
                previewEnv: { status: "ready", headSha: "newest" },
            });
            expect(status).toEqual({ kind: "pending_checks" });
        });

        it("goes stale behind a newer commit's build failure", () => {
            const status = computePrPipelineStatus({
                activeSnapshot: { headSha: "old", summary },
                latestRun: { status: "failed", headSha: "middle" },
                previewEnv: { status: "failed", headSha: "newest" },
            });
            expect(status).toEqual({ kind: "build_failed" });
        });

        it("never shows a checkpoint from an earlier commit while it is current", () => {
            // A stale failure may fall through, but it must never resolve to the previous run's green summary.
            const status = computePrPipelineStatus({
                activeSnapshot: { headSha: "old", summary },
                latestRun: { status: "failed", headSha: "new" },
                previewEnv: { status: "ready", headSha: "new" },
            });
            expect(status).not.toEqual({ kind: "checkpoint", summary });
        });

        it("loses to a re-run that is already in flight", () => {
            const status = computePrPipelineStatus({
                activeSnapshot: { headSha: "old", summary },
                latestRun: { status: "processing" },
                previewEnv: { status: "ready", headSha: "new" },
            });
            expect(status).toEqual({ kind: "analyzing" });
        });

        it("reads as analysis_failed even when the branch has never had a promoted checkpoint", () => {
            const status = computePrPipelineStatus({ latestRun: { status: "failed", headSha: "new" } });
            expect(status).toEqual({ kind: "analysis_failed" });
        });
    });
});
