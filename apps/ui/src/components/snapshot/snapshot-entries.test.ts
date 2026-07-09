import { describe, expect, it } from "vitest";
import type { AffectedTest, CreatedTest, SnapshotChange } from "./diffs-timeline-types";
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

// An affected test links the generation that regenerated it to confirm the
// change did not break it.
function affectedTest(): AffectedTest {
    return {
        affectedReason: "code_change",
        reasoning: "Login selector changed",
        testCase: TEST_CASE,
        generation: {
            id: "gen-1",
            status: "success",
            generationReview: { reasoning: "Healed selector" },
        },
    };
}

function entryIn(sections: Section[], title: string): TestEntry | undefined {
    return sections.find((s) => s.title === title)?.entries.find((e) => e.urlId === TEST_CASE.id);
}

function modifiedEntry(sections: Section[]): TestEntry | undefined {
    return entryIn(sections, "Modified");
}

describe("buildSections - affected test categorization", () => {
    it("surfaces the affected test's generation on the modified entry", () => {
        const sections = buildSections({
            changes: [updatedChange()],
            affectedTests: [affectedTest()],
            createdTests: [],
        });

        const entry = modifiedEntry(sections);
        expect(entry?.generation?.id).toBe("gen-1");
    });

    // An affected test with no "updated" change was regenerated but never edited, so
    // it lands in the "Checked" section rather than "Modified".
    it("categorizes an affected-but-not-modified test as checked", () => {
        const sections = buildSections({
            changes: [],
            affectedTests: [affectedTest()],
            createdTests: [],
        });

        expect(modifiedEntry(sections)).toBeUndefined();
        const entry = entryIn(sections, "Checked");
        expect(entry?.category).toBe("checked");
        expect(entry?.generation?.id).toBe("gen-1");
    });
});

describe("buildSections - created tests", () => {
    it("surfaces the coverage justification and generation inspector for an added test", () => {
        const sections = buildSections({
            changes: [addedChange()],
            affectedTests: [],
            createdTests: [createdTest()],
        });

        const entry = sections.find((s) => s.title === "Added")?.entries.find((e) => e.urlId === NEW_TEST_CASE.id);
        expect(entry?.reasoning).toBe(
            "A guest user can complete checkout without signing in and reach the order confirmation page.",
        );
        expect(entry?.plan).toBe("authored plan");
        expect(entry?.generation?.id).toBe("gen-new");
    });

    it("falls back to the change plan when no created-test record exists (legacy snapshot)", () => {
        const sections = buildSections({
            changes: [addedChange()],
            affectedTests: [],
            createdTests: [],
        });

        const entry = sections.find((s) => s.title === "Added")?.entries.find((e) => e.urlId === NEW_TEST_CASE.id);
        expect(entry?.plan).toBe("change plan");
        expect(entry?.reasoning).toBeUndefined();
        expect(entry?.generation).toBeUndefined();
    });
});
