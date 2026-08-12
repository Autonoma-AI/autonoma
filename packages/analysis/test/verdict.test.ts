import {
    type AnalysisFlow,
    type AnalysisFlowMember,
    analysisFlowPillLabel,
    analysisPrTitle,
    summarizeAnalysisFlow,
    tallyAnalysisFlows,
} from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { deriveAnalysisVerdict, derivePrVerdict } from "../src/verdict";

function member(slug: string, category: string, overrides?: Partial<AnalysisFlowMember>): AnalysisFlowMember {
    return {
        slug,
        category,
        checkedThisRun: overrides?.checkedThisRun ?? true,
        attributedToClientIssue: overrides?.attributedToClientIssue ?? false,
    };
}

function flow(members: AnalysisFlowMember[]): AnalysisFlow {
    return summarizeAnalysisFlow({ title: "Checkout", detail: "" }, members);
}

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

describe("PR-level reads over the tally", () => {
    const verified = flow([member("a", "passed")]);
    const blocked = flow([member("b", "engine_artifact")]);
    const both = [verified, blocked];

    it("compresses to a ratio pill, and only an open bug reads as an alarm", () => {
        expect(analysisFlowPillLabel("not_confirmed", tallyAnalysisFlows(both), 0)).toBe("1/2 verified");
        expect(analysisFlowPillLabel("healthy", tallyAnalysisFlows([verified]), 0)).toBe("1/1 verified");
        expect(analysisFlowPillLabel("bug_found", tallyAnalysisFlows(both), 2)).toBe("2 bugs");
    });

    it("derives the same verdict state every surface renders", () => {
        const counts = { investigatedCount: 2, coverageGapCount: 1 };
        expect(derivePrVerdict({ flows: both, openBugCount: 0, ...counts })).toBe("not_confirmed");
        expect(derivePrVerdict({ flows: [verified], openBugCount: 0, ...counts })).toBe("healthy");
        expect(derivePrVerdict({ flows: both, openBugCount: 1, ...counts })).toBe("bug_found");
    });

    it("titles a run by its verdict, and only states our decision when no test was needed", () => {
        expect(analysisPrTitle("Checkout verified", "healthy", 0)).toBe("Checkout verified");
        expect(analysisPrTitle("Checkout verified", "bug_found", 2)).toBe("Autonoma found 2 bugs in this PR");
        expect(analysisPrTitle("anything", "no_tests_needed", 0)).toBe("No tests needed for this change");
        // A run whose authored title did not survive still owes the reader the shape of the outcome.
        expect(analysisPrTitle("", "not_confirmed", 0)).toBe("Autonoma couldn't confirm this change");
    });
});

describe("a report with no flow itemization", () => {
    const noFlows = { flows: [], openBugCount: 0 };

    it("falls back to the run's own counts rather than claiming nothing needed testing", () => {
        expect(derivePrVerdict({ ...noFlows, investigatedCount: 12, coverageGapCount: 6 })).toBe("not_confirmed");
        expect(derivePrVerdict({ ...noFlows, investigatedCount: 12, coverageGapCount: 0 })).toBe("healthy");
        expect(derivePrVerdict({ ...noFlows, openBugCount: 1, investigatedCount: 12, coverageGapCount: 0 })).toBe(
            "bug_found",
        );
    });

    it("still reads no_tests_needed when the run genuinely investigated nothing", () => {
        expect(derivePrVerdict({ ...noFlows, investigatedCount: 0, coverageGapCount: 0 })).toBe("no_tests_needed");
    });

    it("gives the pill and the title copy the verdict earns, not the empty-flow copy", () => {
        expect(analysisFlowPillLabel("not_confirmed", tallyAnalysisFlows([]), 0)).toBe("Not confirmed");
        expect(analysisFlowPillLabel("healthy", tallyAnalysisFlows([]), 0)).toBe("Passing");
        expect(analysisPrTitle("", "not_confirmed", 0)).toBe("Autonoma couldn't confirm this change");
    });
});
