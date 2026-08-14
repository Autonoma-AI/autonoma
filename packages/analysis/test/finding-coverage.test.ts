import { ANALYSIS_VERDICT } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { type PlaneFinding, summarizeFindings } from "../src/queries/finding-coverage";

let nextId = 0;
function finding(category: string, issueId?: string): PlaneFinding {
    nextId += 1;
    return { id: `finding-${nextId}`, issueId, category };
}

/**
 * The rail's bug count is the number of DISTINCT bugs a run surfaced, not the `client_bug` findings it filed. Many
 * tests can hit one underlying bug, which the Reporter dedupes into one branch issue - so the summarizer must dedupe
 * by attributed issue to match the report headline, not count findings.
 */
describe("summarizeFindings distinct-bug count", () => {
    it("collapses many client_bug findings on one issue into a single bug", () => {
        const summary = summarizeFindings([
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
        ]);
        expect(summary.bugCount).toBe(1);
        // A bug of any multiplicity still reads bug_found.
        expect(summary.state).toBe("bug_found");
    });

    it("counts distinct issues separately", () => {
        const summary = summarizeFindings([
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
            finding(ANALYSIS_VERDICT.client_bug, "issue-b"),
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
        ]);
        expect(summary.bugCount).toBe(2);
    });

    it("counts each unattributed client_bug on its own, keyed to the finding", () => {
        const summary = summarizeFindings([finding(ANALYSIS_VERDICT.client_bug), finding(ANALYSIS_VERDICT.client_bug)]);
        expect(summary.bugCount).toBe(2);
    });

    it("keeps passed and coverage counts per-finding while bugs dedupe", () => {
        const summary = summarizeFindings([
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
            finding(ANALYSIS_VERDICT.client_bug, "issue-a"),
            finding(ANALYSIS_VERDICT.passed),
            finding(ANALYSIS_VERDICT.passed),
            finding(ANALYSIS_VERDICT.engine_artifact),
        ]);
        expect(summary.bugCount).toBe(1);
        expect(summary.passedCount).toBe(2);
        expect(summary.coverage.total).toBe(1);
        // The three no longer sum to the test count once bugs dedupe - that is the intended run-vs-report reading.
        expect(summary.testCount).toBe(5);
    });

    it("reads no bug when nothing was judged a client_bug", () => {
        const summary = summarizeFindings([
            finding(ANALYSIS_VERDICT.passed),
            finding(ANALYSIS_VERDICT.engine_artifact),
        ]);
        expect(summary.bugCount).toBe(0);
        expect(summary.state).toBe("not_confirmed");
    });
});
