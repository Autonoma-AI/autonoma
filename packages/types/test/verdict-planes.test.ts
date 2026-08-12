import { describe, expect, it } from "vitest";
import { summarizeVerdictPlanes } from "../src/verdict-planes";

describe("summarizeVerdictPlanes", () => {
    it("summarizes coverage findings per category", () => {
        const coverage = summarizeVerdictPlanes([
            "engine_artifact",
            "scenario_issue",
            "plan_mismatch",
            "plan_mismatch",
            "plan_mismatch",
        ]);

        expect(coverage.total).toBe(5);
        expect(coverage.byCategory).toEqual([
            { category: "engine_artifact", count: 1 },
            { category: "scenario_issue", count: 1 },
            { category: "plan_mismatch", count: 3 },
        ]);
    });

    it("counts invalid_test on the coverage plane", () => {
        const coverage = summarizeVerdictPlanes(["passed", "invalid_test", "invalid_test"]);

        expect(coverage.total).toBe(2);
        expect(coverage.byCategory).toEqual([{ category: "invalid_test", count: 2 }]);
    });

    it("never counts client_bug on the coverage plane", () => {
        const coverage = summarizeVerdictPlanes(["client_bug", "engine_artifact"]);

        expect(coverage.byCategory).toEqual([{ category: "engine_artifact", count: 1 }]);
        expect(coverage.total).toBe(1);
    });

    it("keeps a passing run off the coverage plane", () => {
        const coverage = summarizeVerdictPlanes(["passed", "passed"]);

        expect(coverage.total).toBe(0);
        expect(coverage.byCategory).toEqual([]);
    });

    it("treats an empty finding set as an empty coverage summary", () => {
        const coverage = summarizeVerdictPlanes([]);
        expect(coverage).toEqual({ byCategory: [], total: 0 });
    });
});
