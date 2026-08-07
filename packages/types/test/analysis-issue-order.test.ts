import { describe, expect, it } from "vitest";
import { type AnalysisIssueKind, type AnalysisIssueSeverity, compareAnalysisIssues } from "../src/schemas/analysis";

/**
 * The ONE comparator behind every open-issues list (the PR page, the PR comment, the merge-gate bug list, main's
 * problem rail), so none of them can present the same issues in a different order.
 */
describe("compareAnalysisIssues", () => {
    function order(issues: { kind: AnalysisIssueKind; severity: AnalysisIssueSeverity }[]): string[] {
        return [...issues].sort(compareAnalysisIssues).map((issue) => `${issue.kind}:${issue.severity}`);
    }

    it("puts bugs ahead of every other kind, however severe the others are", () => {
        // A critical coverage-plane problem sorts below a low-severity app bug: only a bug is a claim about
        // the application.
        expect(
            order([
                { kind: "environment", severity: "critical" },
                { kind: "bug", severity: "low" },
                { kind: "scenario", severity: "critical" },
            ]),
        ).toEqual(["bug:low", "environment:critical", "scenario:critical"]);
    });

    it("orders by descending severity within a class", () => {
        expect(
            order([
                { kind: "bug", severity: "medium" },
                { kind: "bug", severity: "critical" },
                { kind: "bug", severity: "low" },
                { kind: "bug", severity: "high" },
            ]),
        ).toEqual(["bug:critical", "bug:high", "bug:medium", "bug:low"]);
    });

    it("ranks the non-bug kinds by severity alone, without preferring one kind over another", () => {
        expect(
            order([
                { kind: "scenario", severity: "low" },
                { kind: "environment", severity: "high" },
            ]),
        ).toEqual(["environment:high", "scenario:low"]);
        expect(
            compareAnalysisIssues({ kind: "environment", severity: "high" }, { kind: "scenario", severity: "high" }),
        ).toBe(0);
    });
});
