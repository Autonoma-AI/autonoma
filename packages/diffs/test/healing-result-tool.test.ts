import { describe, expect, it } from "vitest";
import { HealingResultTool } from "../src/agents/healing/healing-result-tool";
import type { HealingTestCandidate } from "../src/healing/types";
import { makeHealingLoop } from "./test-loops";

const candidate: HealingTestCandidate = {
    candidateId: "cand-1",
    name: "New signup flow",
    instruction: "Navigate to /signup and register",
    reasoning: "The diff adds a signup page",
};

describe("healing finish tool conjunction", () => {
    it("finishes when there are no failures and no candidates", async () => {
        const loop = makeHealingLoop();
        const tool = new HealingResultTool();

        const result = await tool.buildResult({ reasoning: "nothing to do" }, loop);

        expect(result.actions).toEqual([]);
        expect(result.newTests).toEqual([]);
        expect(result.rejectedCandidates).toEqual([]);
    });

    it("rejects finishing while a failure is unhandled", async () => {
        const loop = makeHealingLoop({ failureKeys: new Set(["plan-1"]) });
        const tool = new HealingResultTool();

        await expect(tool.buildResult({ reasoning: "done" }, loop)).rejects.toThrow(/not handled/i);
    });

    it("rejects finishing while a candidate is undecided", async () => {
        const loop = makeHealingLoop({ candidates: [candidate] });
        const tool = new HealingResultTool();

        await expect(tool.buildResult({ reasoning: "done" }, loop)).rejects.toThrow(/not decided/i);
    });

    it("finishes when the only candidate was accepted via add_test", async () => {
        const loop = makeHealingLoop({ candidates: [candidate] });
        loop.claimedCandidateIds.add("cand-1");
        const tool = new HealingResultTool();

        const result = await tool.buildResult({ reasoning: "accepted the candidate" }, loop);

        expect(result.rejectedCandidates).toEqual([]);
    });

    it("finishes when the only candidate was rejected at finish", async () => {
        const loop = makeHealingLoop({ candidates: [candidate] });
        const tool = new HealingResultTool();

        const result = await tool.buildResult(
            { reasoning: "rejected the candidate", rejectedCandidates: [{ candidateId: "cand-1", reasoning: "dupe" }] },
            loop,
        );

        expect(result.rejectedCandidates).toHaveLength(1);
    });

    it("rejects a candidate that is both accepted and rejected", async () => {
        const loop = makeHealingLoop({ candidates: [candidate] });
        loop.claimedCandidateIds.add("cand-1");
        const tool = new HealingResultTool();

        await expect(
            tool.buildResult({ reasoning: "x", rejectedCandidates: [{ candidateId: "cand-1", reasoning: "?" }] }, loop),
        ).rejects.toThrow(/both accepted/i);
    });
});
