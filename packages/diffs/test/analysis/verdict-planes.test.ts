import { describe, expect, it } from "vitest";
import { summarizeVerdictPlanes } from "../../src/analysis/verdict-planes";

describe("summarizeVerdictPlanes", () => {
    it("stays on the passed plane and summarizes coverage findings per category", () => {
        const summary = summarizeVerdictPlanes([
            "engine_artifact",
            "scenario_issue",
            "plan_mismatch",
            "plan_mismatch",
            "plan_mismatch",
        ]);

        expect(summary.verdict).toBe("passed");
        expect(summary.coverage.total).toBe(5);
        expect(summary.coverage.byCategory).toEqual([
            { category: "engine_artifact", count: 1 },
            { category: "scenario_issue", count: 1 },
            { category: "plan_mismatch", count: 3 },
        ]);
    });

    it("counts invalid_test on the coverage plane and never lets it flip the app-health verdict", () => {
        const summary = summarizeVerdictPlanes(["passed", "invalid_test", "invalid_test"]);

        expect(summary.verdict).toBe("passed");
        expect(summary.coverage.total).toBe(2);
        expect(summary.coverage.byCategory).toEqual([{ category: "invalid_test", count: 2 }]);
    });

    it("flips to client_bug when any finding is one, and never counts client_bug on the coverage plane", () => {
        const summary = summarizeVerdictPlanes(["client_bug", "engine_artifact"]);

        expect(summary.verdict).toBe("client_bug");
        expect(summary.coverage.byCategory).toEqual([{ category: "engine_artifact", count: 1 }]);
        expect(summary.coverage.total).toBe(1);
    });

    it("keeps a passing app-health run off the coverage plane", () => {
        const summary = summarizeVerdictPlanes(["passed", "passed"]);

        expect(summary.verdict).toBe("passed");
        expect(summary.coverage.total).toBe(0);
        expect(summary.coverage.byCategory).toEqual([]);
    });

    it("treats an empty finding set as passed with an empty coverage summary", () => {
        const summary = summarizeVerdictPlanes([]);
        expect(summary.verdict).toBe("passed");
        expect(summary.coverage).toEqual({ byCategory: [], total: 0 });
    });
});
