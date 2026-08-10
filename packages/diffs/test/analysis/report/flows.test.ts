import type { AnalysisFlowMember } from "@autonoma/types";
import { describe, expect, it } from "vitest";
import { type AuthoredFlow, partitionFlows } from "../../../src/analysis/report/flows";

function member(slug: string, category: string): AnalysisFlowMember {
    return { slug, category, checkedThisRun: true, attributedToClientIssue: false };
}

function authored(title: string, testSlugs: string[]): AuthoredFlow {
    return { title, detail: `${title} detail`, testSlugs };
}

/**
 * The completeness obligation is enforced by construction here rather than by rejecting the agent's `finish`: a
 * partition violation costs a good label, never a verdict, so failing the run over one would trade a whole PR comment
 * for a nicer name.
 */
describe("partitionFlows", () => {
    it("sweeps every unplaced test into one flow that keeps its real verdict", () => {
        const members = [member("a", "passed"), member("b", "engine_artifact"), member("c", "passed")];

        const result = partitionFlows([authored("Checkout", ["a"])], members);

        expect(result.flows.map((flow) => flow.title)).toEqual(["Checkout", "Other checks"]);
        expect(result.sweptSlugs).toEqual(["b", "c"]);
        const swept = result.flows[1];
        // The sweep is a naming fallback, not a verdict fallback: b's gap still counts and still reads as ours.
        expect(swept?.status).toBe("partial");
        expect(swept?.gapCount).toBe(1);
        expect(swept?.passedCount).toBe(1);
        expect(swept?.owner).toBe("autonoma");
    });

    it("leaves nothing swept when the agent placed every test", () => {
        const members = [member("a", "passed"), member("b", "passed")];

        const result = partitionFlows([authored("Checkout", ["a"]), authored("Login", ["b"])], members);

        expect(result.flows.map((flow) => flow.title)).toEqual(["Checkout", "Login"]);
        expect(result.sweptSlugs).toEqual([]);
    });

    it("keeps a doubly-cited test in the first flow that claimed it, so the flows stay a partition", () => {
        // Counting one test twice would inflate the denominator and let a gap read as verified elsewhere.
        const members = [member("a", "engine_artifact")];

        const result = partitionFlows([authored("Checkout", ["a"]), authored("Billing", ["a"])], members);

        expect(result.duplicateSlugs).toEqual(["a"]);
        expect(result.flows.map((flow) => flow.title)).toEqual(["Checkout"]);
        expect(result.flows[0]?.testSlugs).toEqual(["a"]);
    });

    it("drops a cited test that is not in the branch's map rather than inventing it", () => {
        const result = partitionFlows([authored("Checkout", ["a", "ghost"])], [member("a", "passed")]);

        expect(result.unknownSlugs).toEqual(["ghost"]);
        expect(result.flows[0]?.testSlugs).toEqual(["a"]);
    });

    it("drops a flow left with no evidence instead of rendering it", () => {
        // An empty flow would read `unverified` and imply we tried something we never did.
        const result = partitionFlows([authored("Ghost flow", ["nope"])], [member("a", "passed")]);

        expect(result.flows.map((flow) => flow.title)).toEqual(["Other checks"]);
    });
});
