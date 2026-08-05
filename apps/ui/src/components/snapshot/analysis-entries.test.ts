import type { AnalysisClassificationSummary, AnalysisFindingView } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { buildAnalysisSections } from "./analysis-entries";
import type { SnapshotChange } from "./snapshot-types";
import type { Section, TestEntry } from "./snapshot-entries";

const AFFECTED = { id: "tc-1", name: "checkout-flow.md", slug: "checkout-flow-md" };
const PROPOSED = { id: "tc-2", name: "guest-checkout.md", slug: "guest-checkout-md" };

function finding(overrides: Partial<AnalysisFindingView> = {}): AnalysisFindingView {
    return {
        id: "finding-1",
        slug: AFFECTED.slug,
        generationId: "gen-1",
        testCase: AFFECTED,
        category: "passed",
        headline: "Checkout still completes",
        origin: "pre_existing",
        selectionReason: "The diff rewrites the submit handler this test drives.",
        evidence: [],
        classifications: [classification(1)],
        ...overrides,
    };
}

/** One iteration of the run's self-heal loop; a finding with two of them is one the run rewrote and re-ran. */
function classification(number: number): AnalysisClassificationSummary {
    return {
        id: `cls-${number}`,
        number,
        generationId: `gen-${number}`,
        category: "plan_mismatch",
        headline: "The toast copy changed",
        createdAt: new Date("2026-07-27T18:00:00Z"),
    };
}

function updatedChange(): SnapshotChange {
    return {
        type: "updated",
        testCaseId: AFFECTED.id,
        testCaseName: AFFECTED.name,
        testCaseSlug: AFFECTED.slug,
        testCaseFolderId: "folder-1",
        plan: "new plan",
        previousPlan: "old plan",
    };
}

function entryIn(sections: Section[], title: string): TestEntry | undefined {
    return sections.find((s) => s.title === title)?.entries[0];
}

describe("buildAnalysisSections - categorization from the run's own record", () => {
    // The bug this guards: a selected test the run did not need to edit produces no plan diff, so a
    // changes-driven view drops it entirely. The finding still exists, so it must surface as "checked".
    it("lists a selected test the run left unedited as checked, with no plan diff to go on", () => {
        const sections = buildAnalysisSections({ findings: [finding()], changes: [] });

        const entry = entryIn(sections, "Checked");
        expect(entry?.category).toBe("checked");
        expect(entry?.testName).toBe("checkout-flow.md");
        expect(entry?.reasoning).toBe("The diff rewrites the submit handler this test drives.");
        expect(entryIn(sections, "Modified")).toBeUndefined();
    });

    it("categorizes a self-healed test as modified and carries the previous plan from the diff", () => {
        const sections = buildAnalysisSections({
            findings: [finding({ classifications: [classification(1), classification(2)] })],
            changes: [updatedChange()],
        });

        const entry = entryIn(sections, "Modified");
        expect(entry?.category).toBe("modified");
        expect(entry?.previousPlan).toBe("old plan");
        expect(entry?.verdict?.selfHealed).toBe(true);
    });

    it("categorizes a test authored this run as added", () => {
        const sections = buildAnalysisSections({
            findings: [finding({ id: "finding-2", slug: PROPOSED.slug, testCase: PROPOSED, origin: "proposed" })],
            changes: [],
        });

        expect(entryIn(sections, "Added")?.category).toBe("added");
    });

    it("categorizes a kept plan_mismatch as checked even though it self-healed (the rewrite was reverted)", () => {
        const sections = buildAnalysisSections({
            findings: [finding({ category: "plan_mismatch", classifications: [classification(1), classification(2)] })],
            changes: [],
        });

        expect(entryIn(sections, "Checked")?.category).toBe("checked");
        expect(entryIn(sections, "Modified")).toBeUndefined();
    });

    it("categorizes an invalid_test as removed - its assignment was dropped from the twin", () => {
        const sections = buildAnalysisSections({
            findings: [finding({ category: "invalid_test", headline: "asserts a feature that never existed" })],
            changes: [],
        });

        expect(entryIn(sections, "Removed")?.category).toBe("removed");
        expect(entryIn(sections, "Checked")).toBeUndefined();
    });

    it("categorizes a proposed test the run found invalid as removed, not added", () => {
        const sections = buildAnalysisSections({
            findings: [
                finding({
                    id: "finding-2",
                    slug: PROPOSED.slug,
                    testCase: PROPOSED,
                    origin: "proposed",
                    category: "invalid_test",
                }),
            ],
            changes: [],
        });

        expect(entryIn(sections, "Removed")?.category).toBe("removed");
        expect(entryIn(sections, "Added")).toBeUndefined();
    });
});

describe("buildAnalysisSections - verdict and run links", () => {
    it("carries the verdict, its headline, and the ids to open the finding and the run that produced it", () => {
        const sections = buildAnalysisSections({
            findings: [
                finding({ category: "client_bug", headline: "Place order never enables", generationId: "gen-9" }),
            ],
            changes: [],
        });

        const entry = entryIn(sections, "Checked");
        expect(entry?.verdict).toEqual({
            category: "client_bug",
            headline: "Place order never enables",
            findingId: "finding-1",
            generationId: "gen-9",
            selfHealed: false,
        });
    });
});
