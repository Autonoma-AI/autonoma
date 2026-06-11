import { describe, expect, it } from "vitest";
import type { AffectedTest, ExecutedTest, SnapshotChange } from "./diffs-timeline-types";
import { buildSections, type Section, type TestEntry } from "./snapshot-entries";

const TEST_CASE = { id: "tc-1", name: "Checkout flow", slug: "checkout-flow" };

function updatedChange(): SnapshotChange {
    return {
        type: "updated",
        testCaseId: TEST_CASE.id,
        testCaseName: TEST_CASE.name,
        testCaseSlug: TEST_CASE.slug,
        testCaseFolderId: "folder-1",
        plan: "new plan",
        previousPlan: "old plan",
    };
}

// The affected test pins `run` to the initial replay that detected the failure
// (status "failed"), and links the generation that subsequently modified it.
function affectedWithInitialRun(): AffectedTest {
    return {
        affectedReason: "code_change",
        reasoning: "Login selector changed",
        testCase: TEST_CASE,
        run: {
            id: "run-initial",
            status: "failed",
            runReview: { verdict: "engine_error", reasoning: "Element not found" },
        },
        generation: {
            id: "gen-1",
            status: "success",
            generationReview: { reasoning: "Healed selector" },
        },
    };
}

// The latest executed run for the test case is the post-fix validation replay
// (status "success") created by the refinement loop.
function executedWithLatestRun(): ExecutedTest {
    return {
        source: "replay",
        testCase: TEST_CASE,
        runId: "run-latest",
        generationId: "gen-1",
        status: "success",
        finalOutcome: "passed",
        verdict: null,
        reviewReasoning: null,
        startedAt: new Date("2026-01-01T10:05:00Z"),
        completedAt: new Date("2026-01-01T10:06:00Z"),
        createdAt: new Date("2026-01-01T10:04:00Z"),
        latestRunAt: new Date("2026-01-01T10:05:00Z"),
    };
}

function modifiedEntry(sections: Section[]): TestEntry | undefined {
    return sections.find((s) => s.title === "Modified")?.entries.find((e) => e.urlId === TEST_CASE.id);
}

describe("buildSections - modified test run", () => {
    it("shows the latest replay run, not the initial replay that detected the failure", () => {
        const sections = buildSections({
            changes: [updatedChange()],
            affectedTests: [affectedWithInitialRun()],
            testCandidates: [],
            quarantinedTests: [],
            executedTests: [executedWithLatestRun()],
        });

        const entry = modifiedEntry(sections);
        expect(entry?.run?.id).toBe("run-latest");
        expect(entry?.run?.status).toBe("success");
    });

    it("falls back to the initial replay run when no executed run exists yet", () => {
        const sections = buildSections({
            changes: [updatedChange()],
            affectedTests: [affectedWithInitialRun()],
            testCandidates: [],
            quarantinedTests: [],
            executedTests: [],
        });

        const entry = modifiedEntry(sections);
        expect(entry?.run?.id).toBe("run-initial");
        expect(entry?.run?.status).toBe("failed");
    });

    it("surfaces the latest run for an affected test that has no recorded change", () => {
        const sections = buildSections({
            changes: [],
            affectedTests: [affectedWithInitialRun()],
            testCandidates: [],
            quarantinedTests: [],
            executedTests: [executedWithLatestRun()],
        });

        const entry = modifiedEntry(sections);
        expect(entry?.run?.id).toBe("run-latest");
    });
});
