import { describe, expect, it } from "vitest";
import { analysisVerdictHeadline, analysisVerdictLabel, deriveAnalysisVerdict } from "../src/schemas/analysis";

/**
 * The ONE predicate every surface (GitHub comment, merge-gate check-run, UI checkpoint badge) renders, so they can
 * never disagree. These pin the core promise: a coverage gap of ANY kind downgrades a bug-free run off green.
 */
describe("deriveAnalysisVerdict", () => {
    it("is bug_found whenever there is an open bug, regardless of anything else", () => {
        expect(deriveAnalysisVerdict({ bugCount: 1, coverageGapCount: 0, investigatedCount: 3 })).toBe("bug_found");
        // A bug carried across snapshots keeps the PR red even when nothing re-ran this snapshot.
        expect(deriveAnalysisVerdict({ bugCount: 2, coverageGapCount: 0, investigatedCount: 0 })).toBe("bug_found");
    });

    it("is healthy only on a clean sweep - tests ran and every one confirmed the app", () => {
        expect(deriveAnalysisVerdict({ bugCount: 0, coverageGapCount: 0, investigatedCount: 4 })).toBe("healthy");
    });

    it("is not_confirmed on any coverage gap, even when other tests passed", () => {
        // 3 passed + 6 unconfirmed is not a green run.
        expect(deriveAnalysisVerdict({ bugCount: 0, coverageGapCount: 6, investigatedCount: 9 })).toBe("not_confirmed");
        // Nothing passed, everything blocked - also not_confirmed (the degree lives in the copy, not the state).
        expect(deriveAnalysisVerdict({ bugCount: 0, coverageGapCount: 3, investigatedCount: 3 })).toBe("not_confirmed");
    });

    it("is no_tests_needed when nothing was exercised - a decision, not an absence", () => {
        // Nothing reached a verdict, which the Reporter's persist-time guard makes equivalent to the run queueing
        // nothing: Impact Analysis marked no test affected and authored none.
        expect(deriveAnalysisVerdict({ bugCount: 0, coverageGapCount: 0, investigatedCount: 0 })).toBe(
            "no_tests_needed",
        );
    });

    it("keeps the environment/scenario issues a branch carries under the no_tests_needed verdict", () => {
        // The run needed no test, so it cleared none of the gaps earlier runs left open. Those are still the
        // branch's, and the verdict says what THIS run decided - it does not get downgraded by them.
        expect(deriveAnalysisVerdict({ bugCount: 0, coverageGapCount: 2, investigatedCount: 0 })).toBe(
            "no_tests_needed",
        );
    });
});

describe("analysisVerdictLabel + analysisVerdictHeadline", () => {
    it("leads with what we learned about the change, not with whether a bug was found", () => {
        expect(analysisVerdictLabel("healthy")).toBe("HEALTHY");
        expect(analysisVerdictHeadline({ bugCount: 0, coverageGapCount: 0, investigatedCount: 4 })).toBe(
            "Autonoma verified this change - the app held up.",
        );

        expect(analysisVerdictLabel("not_confirmed")).toBe("NOT CONFIRMED");
        expect(analysisVerdictHeadline({ bugCount: 0, coverageGapCount: 1, investigatedCount: 4 })).toBe(
            "Autonoma couldn't confirm this change - 1 check didn't complete.",
        );
        expect(analysisVerdictHeadline({ bugCount: 0, coverageGapCount: 2, investigatedCount: 4 })).toBe(
            "Autonoma couldn't confirm this change - 2 checks didn't complete.",
        );

        expect(analysisVerdictLabel("bug_found")).toBe("BUG FOUND");
        expect(analysisVerdictHeadline({ bugCount: 1, coverageGapCount: 0, investigatedCount: 3 })).toBe(
            "Autonoma found 1 bug in this PR.",
        );
        expect(analysisVerdictHeadline({ bugCount: 2, coverageGapCount: 0, investigatedCount: 3 })).toBe(
            "Autonoma found 2 bugs in this PR.",
        );
    });

    it("states the no-tests decision as ours, never as a claim about the reader's codebase", () => {
        expect(analysisVerdictLabel("no_tests_needed")).toBe("NO TESTS NEEDED");
        const headline = analysisVerdictHeadline({ bugCount: 0, coverageGapCount: 0, investigatedCount: 0 });
        expect(headline).toBe("No tests needed for this change.");
        // Two of three sampled zero-test runs were user-facing changes we deliberately declined to cover, so the
        // headline may never generalize from "we ran nothing" to "this change does not touch the UI".
        expect(headline).not.toMatch(/UI|user-facing|interface/i);
    });
});
