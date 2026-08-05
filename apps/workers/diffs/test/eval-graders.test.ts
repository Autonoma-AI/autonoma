import type { CreatedTest, DiffsAgentResult } from "@autonoma/diffs";
import { describe, expect, it } from "vitest";
import { checkAnalysisResult } from "../evals/analysis/analysis-frontmatter";

function diffsResult(createdTests: CreatedTest[]): DiffsAgentResult {
    return { affectedTests: [], createdTests, reasoning: "ok" };
}

function createdTest(overrides: Partial<CreatedTest> = {}): CreatedTest {
    return {
        name: "New checkout promo flow",
        folderName: "Checkout",
        description: "A shopper applying a valid promo code at checkout sees the order total drop by the discount.",
        plan: "Apply a promo code at checkout and verify the discount.",
        scenarioId: undefined,
        coverageJustification: "No existing test exercises the promo-code field added by this diff.",
        ...overrides,
    };
}

describe("analysis dedup grader", () => {
    it("bounds how many tests create_test may author", () => {
        const result = diffsResult([createdTest(), createdTest({ name: "Second" })]);
        const failures = checkAnalysisResult(result, { createdTests: { count: { maxCount: 1 } } });
        expect(failures.map((f) => f.check)).toEqual(["createdTests.maxCount"]);
    });

    it("rejects a new test authored into an already-covered folder", () => {
        const result = diffsResult([createdTest({ folderName: "Checkout" })]);
        const failures = checkAnalysisResult(result, { createdTests: { folders: { exclude: ["Checkout"] } } });
        expect(failures.map((f) => f.check)).toEqual(["createdTests.folders.exclude"]);
    });

    it("flags an authored test with a blank coverage justification regardless of frontmatter", () => {
        const result = diffsResult([createdTest({ coverageJustification: "   " })]);
        const failures = checkAnalysisResult(result, {});
        expect(failures.map((f) => f.check)).toEqual(["createdTests.coverageJustification"]);
    });

    it("flags an authored test with a trivial description regardless of frontmatter", () => {
        const result = diffsResult([createdTest({ description: "checkout" })]);
        const failures = checkAnalysisResult(result, {});
        expect(failures.map((f) => f.check)).toEqual(["createdTests.description"]);
    });
});
