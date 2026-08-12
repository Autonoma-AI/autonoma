import { describe, expect, it } from "vitest";
import { type AnalysisVerdictSummary, analysisVerdictHeadline, analysisVerdictLabel } from "../src/schemas/analysis";

/** A resolved verdict, as `BranchLedger.verdict()` hands it to a renderer. */
function verdict(summary: AnalysisVerdictSummary): AnalysisVerdictSummary {
    return summary;
}

describe("analysisVerdictLabel + analysisVerdictHeadline", () => {
    it("leads with what we learned about the change, not with whether a bug was found", () => {
        expect(analysisVerdictLabel("healthy")).toBe("HEALTHY");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "healthy", bugCount: 0, coverageGapCount: 0, investigatedCount: 4 }),
            ),
        ).toBe("Autonoma verified this change - the app held up.");

        expect(analysisVerdictLabel("not_confirmed")).toBe("NOT CONFIRMED");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "not_confirmed", bugCount: 0, coverageGapCount: 1, investigatedCount: 4 }),
            ),
        ).toBe("Autonoma couldn't confirm this change - 1 check didn't complete.");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "not_confirmed", bugCount: 0, coverageGapCount: 2, investigatedCount: 4 }),
            ),
        ).toBe("Autonoma couldn't confirm this change - 2 checks didn't complete.");

        expect(analysisVerdictLabel("bug_found")).toBe("BUG FOUND");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "bug_found", bugCount: 1, coverageGapCount: 0, investigatedCount: 3 }),
            ),
        ).toBe("Autonoma found 1 bug in this PR.");
        expect(
            analysisVerdictHeadline(
                verdict({ state: "bug_found", bugCount: 2, coverageGapCount: 0, investigatedCount: 3 }),
            ),
        ).toBe("Autonoma found 2 bugs in this PR.");
    });

    it("states the no-tests decision as ours, never as a claim about the reader's codebase", () => {
        expect(analysisVerdictLabel("no_tests_needed")).toBe("NO TESTS NEEDED");
        const headline = analysisVerdictHeadline(
            verdict({ state: "no_tests_needed", bugCount: 0, coverageGapCount: 0, investigatedCount: 0 }),
        );
        expect(headline).toBe("No tests needed for this change.");
        // Two of three sampled zero-test runs were user-facing changes we deliberately declined to cover, so the
        // headline may never generalize from "we ran nothing" to "this change does not touch the UI".
        expect(headline).not.toMatch(/UI|user-facing|interface/i);
    });
});
