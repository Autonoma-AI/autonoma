import { describe, expect, it } from "vitest";
import type { AffectedTest, CreatedTest, ExecutedTest, SnapshotChange } from "./diffs-timeline-types";
import { buildSections, type Section, type TestEntry } from "./snapshot-entries";

const TEST_CASE = { id: "tc-1", name: "Checkout flow", slug: "checkout-flow" };

const NEW_TEST_CASE = { id: "tc-2", name: "Guest checkout", slug: "guest-checkout", folderId: "folder-1" };

function addedChange(): SnapshotChange {
    return {
        type: "added",
        testCaseId: NEW_TEST_CASE.id,
        testCaseName: NEW_TEST_CASE.name,
        testCaseSlug: NEW_TEST_CASE.slug,
        testCaseFolderId: NEW_TEST_CASE.folderId,
        plan: "change plan",
    };
}

function createdTest(): CreatedTest {
    return {
        testCase: NEW_TEST_CASE,
        description: "A guest user can complete checkout without signing in and reach the order confirmation page.",
        plan: "authored plan",
        generation: { id: "gen-new", status: "success", verdict: "success", reviewReasoning: "Generated cleanly." },
        run: { id: "run-new", status: "success", verdict: undefined, reviewReasoning: undefined },
        quarantine: undefined,
    };
}

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

function entryIn(sections: Section[], title: string): TestEntry | undefined {
    return sections.find((s) => s.title === title)?.entries.find((e) => e.urlId === TEST_CASE.id);
}

function modifiedEntry(sections: Section[]): TestEntry | undefined {
    return entryIn(sections, "Modified");
}

describe("buildSections - modified test run", () => {
    it("shows the latest replay run, not the initial replay that detected the failure", () => {
        const sections = buildSections({
            changes: [updatedChange()],
            affectedTests: [affectedWithInitialRun()],
            createdTests: [],
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
            createdTests: [],
            quarantinedTests: [],
            executedTests: [],
        });

        const entry = modifiedEntry(sections);
        expect(entry?.run?.id).toBe("run-initial");
        expect(entry?.run?.status).toBe("failed");
    });

    // An affected test with no "updated" change was replayed but never edited, so
    // it lands in the "Checked" section rather than "Modified". It should still
    // surface its latest run.
    it("surfaces the latest run for a checked test (affected but not modified)", () => {
        const sections = buildSections({
            changes: [],
            affectedTests: [affectedWithInitialRun()],
            createdTests: [],
            quarantinedTests: [],
            executedTests: [executedWithLatestRun()],
        });

        expect(modifiedEntry(sections)).toBeUndefined();
        const entry = entryIn(sections, "Checked");
        expect(entry?.category).toBe("checked");
        expect(entry?.run?.id).toBe("run-latest");
    });
});

describe("buildSections - created tests", () => {
    it("surfaces the coverage justification and generation/run inspector for an added test", () => {
        const sections = buildSections({
            changes: [addedChange()],
            affectedTests: [],
            createdTests: [createdTest()],
            quarantinedTests: [],
            executedTests: [],
        });

        const entry = sections.find((s) => s.title === "Added")?.entries.find((e) => e.urlId === NEW_TEST_CASE.id);
        expect(entry?.reasoning).toBe(
            "A guest user can complete checkout without signing in and reach the order confirmation page.",
        );
        expect(entry?.plan).toBe("authored plan");
        expect(entry?.generation?.id).toBe("gen-new");
        expect(entry?.run?.id).toBe("run-new");
    });

    it("falls back to the change plan when no created-test record exists (legacy snapshot)", () => {
        const sections = buildSections({
            changes: [addedChange()],
            affectedTests: [],
            createdTests: [],
            quarantinedTests: [],
            executedTests: [],
        });

        const entry = sections.find((s) => s.title === "Added")?.entries.find((e) => e.urlId === NEW_TEST_CASE.id);
        expect(entry?.plan).toBe("change plan");
        expect(entry?.reasoning).toBeUndefined();
        expect(entry?.generation).toBeUndefined();
    });
});
