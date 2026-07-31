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

    it("is no_tests_affected when nothing was exercised against the diff - never a clean pass", () => {
        expect(deriveAnalysisVerdict({ bugCount: 0, coverageGapCount: 0, investigatedCount: 0 })).toBe(
            "no_tests_affected",
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

        expect(analysisVerdictLabel("no_tests_affected")).toBe("NO TESTS AFFECTED");
    });
});
