import type { AnalysisTestOrigin, AnalysisVerdict } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { summarizeVerdictPlanes, type VerdictPlaneFinding } from "../../src/analysis/verdict-planes";

function finding(category: AnalysisVerdict, origin: AnalysisTestOrigin = "pre_existing"): VerdictPlaneFinding {
    return { category, origin };
}

describe("summarizeVerdictPlanes", () => {
    it("stays on the passed plane and summarizes coverage findings + the delete-origin split", () => {
        const summary = summarizeVerdictPlanes([
            finding("engine_artifact"),
            finding("scenario_issue"),
            finding("delete", "proposed"),
            finding("delete", "pre_existing"),
            finding("delete", "proposed"),
        ]);

        expect(summary.verdict).toBe("passed");
        expect(summary.coverage.total).toBe(5);
        expect(summary.coverage.byCategory).toEqual([
            { category: "engine_artifact", count: 1 },
            { category: "scenario_issue", count: 1 },
            { category: "delete", count: 3 },
        ]);
        expect(summary.coverage.unestablishedProposed).toBe(2);
        expect(summary.coverage.obsoleteRemoved).toBe(1);
    });

    it("flips to client_bug when any finding is one, and never counts client_bug on the coverage plane", () => {
        const summary = summarizeVerdictPlanes([finding("client_bug"), finding("engine_artifact")]);

        expect(summary.verdict).toBe("client_bug");
        expect(summary.coverage.byCategory).toEqual([{ category: "engine_artifact", count: 1 }]);
        expect(summary.coverage.total).toBe(1);
    });

    it("keeps a passing app-health run off the coverage plane", () => {
        const summary = summarizeVerdictPlanes([finding("passed"), finding("passed")]);

        expect(summary.verdict).toBe("passed");
        expect(summary.coverage.total).toBe(0);
        expect(summary.coverage.byCategory).toEqual([]);
    });

    it("treats an empty finding set as passed with an empty coverage summary", () => {
        const summary = summarizeVerdictPlanes([]);
        expect(summary.verdict).toBe("passed");
        expect(summary.coverage).toEqual({ byCategory: [], total: 0, unestablishedProposed: 0, obsoleteRemoved: 0 });
    });
});
