import { describe, expect, it } from "vitest";
import { type AnalysisFlow, type AnalysisFlowMember, summarizeAnalysisFlow } from "../src/schemas/analysis";

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

/**
 * An ABSENT itemization is not an empty one. Every report written before this feature stores `flows = NULL`, which
 * both read boundaries turn into `[]` - so deriving from the flow count alone would stamp a green "no tests needed"
 * over every currently-open PR, including runs that investigated a dozen tests and left half unconfirmed.
 */
