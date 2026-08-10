import { describe, expect, it } from "vitest";
import {
    type AnalysisFlow,
    type AnalysisFlowMember,
    analysisFlowPillLabel,
    analysisPrTitle,
    derivePrVerdict,
    summarizeAnalysisFlow,
    tallyAnalysisFlows,
} from "../src/schemas/analysis";

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
 * The half of a flow the model does NOT author. A model that could set its own status could promote a flow with a
 * failed check to "verified", which is the single failure this derivation exists to prevent.
 */
describe("summarizeAnalysisFlow", () => {
    it("reports a mixed flow as partial and still shows what passed", () => {
        // The case that motivated a four-state status: 3 passes next to 1 gap is not the same reading as 4 gaps,
        // and collapsing them to a flat failure is the pessimism the itemization exists to remove.
        const result = flow([
            member("a", "passed"),
            member("b", "passed"),
            member("c", "passed"),
            member("d", "engine_artifact"),
        ]);

        expect(result.status).toBe("partial");
        expect(result.passedCount).toBe(3);
        expect(result.gapCount).toBe(1);
    });

    it("is broken whenever any cited test found a bug, however much else passed", () => {
        expect(flow([member("a", "passed"), member("b", "client_bug")]).status).toBe("broken");
    });

    it("is verified only when every cited test confirmed the app", () => {
        expect(flow([member("a", "passed"), member("b", "passed")]).status).toBe("verified");
    });

    it("is unverified when nothing passed", () => {
        expect(flow([member("a", "engine_artifact"), member("b", "scenario_issue")]).status).toBe("unverified");
    });

    it("treats a flow citing no test as unverified, never as a pass", () => {
        // Citing nothing establishes nothing. Reading that as green would be a false all-clear.
        expect(flow([]).status).toBe("unverified");
    });

    it("counts how many verdicts came from this run, so a wholly carried flow can say so", () => {
        const result = flow([
            member("a", "passed", { checkedThisRun: false }),
            member("b", "passed", { checkedThisRun: false }),
        ]);

        expect(result.checkedThisRunCount).toBe(0);
    });
});

/** Ownership answers the reader's first question - is this mine to fix - so it may never be guessed. */
describe("flow ownership", () => {
    it("puts a seeded-data gap on the reader and a harness fault on us", () => {
        expect(flow([member("a", "scenario_issue")]).owner).toBe("client");
        expect(flow([member("a", "engine_artifact")]).owner).toBe("autonoma");
    });

    it("reads an environment gap's side off the Reporter's attribution, defaulting to ours", () => {
        // The taxonomy carries no owner for environment_failure: an unplaced one stays ours rather than nagging.
        expect(flow([member("a", "environment_failure")]).owner).toBe("autonoma");
        expect(flow([member("a", "environment_failure", { attributedToClientIssue: true })]).owner).toBe("client");
    });

    it("is the reader's as soon as one gap is theirs, so an actionable flow is never buried under ours", () => {
        expect(flow([member("a", "engine_artifact"), member("b", "scenario_issue")]).owner).toBe("client");
    });

    it("belongs to nobody when there is no gap at all", () => {
        expect(flow([member("a", "passed")]).owner).toBe("none");
    });
});

/**
 * Every PR-level surface counts from this tally, which is what makes them agree by construction - the PR page and the
 * GitHub comment previously fed the verdict from different things and landed on different states for the same run.
 */
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

/**
 * An ABSENT itemization is not an empty one. Every report written before this feature stores `flows = NULL`, which
 * both read boundaries turn into `[]` - so deriving from the flow count alone would stamp a green "no tests needed"
 * over every currently-open PR, including runs that investigated a dozen tests and left half unconfirmed.
 */
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
