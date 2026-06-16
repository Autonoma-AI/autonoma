import { describe, expect, it } from "vitest";
import { HealingAddTestTool, type HealingNewTest } from "../src/agents/healing/tools/add-test-tool";
import { FlowIndex } from "../src/flow-index";
import type { HealingTestCandidate } from "../src/healing/types";
import { ScenarioIndex } from "../src/scenario-index";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeHealingLoop } from "./test-loops";

const flowIndex = new FlowIndex([{ id: "auth-folder", name: "auth", testSlugs: [] }]);
const scenarioIndex = new ScenarioIndex([
    { id: "scenario-admin", name: "authenticated-admin", description: "Logged-in admin user" },
]);

const candidate: HealingTestCandidate = {
    candidateId: "cand-1",
    name: "New signup flow",
    instruction: "Navigate to /signup and register",
    reasoning: "The diff adds a signup page",
};

function newTest(overrides: Partial<HealingNewTest> = {}): HealingNewTest {
    return {
        name: "Test",
        folderName: "auth",
        instruction: "Do something",
        reasoning: "Reason",
        ...overrides,
    };
}

describe("healing add_test tool", () => {
    it("accepts a live candidate and claims it", async () => {
        const loop = makeHealingLoop({ flowIndex, scenarioIndex, candidates: [candidate], isFirstTurn: false });
        const tool = new HealingAddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            newTest({ name: "Signup", acceptingCandidateId: "cand-1" }),
            loop,
        );

        expect(result.success).toBe(true);
        expect(loop.newTests).toHaveLength(1);
    });

    it("rejects an acceptingCandidateId that matches no candidate", async () => {
        const loop = makeHealingLoop({ flowIndex, scenarioIndex, candidates: [candidate], isFirstTurn: true });
        const tool = new HealingAddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            newTest({ acceptingCandidateId: "made-up" }),
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("made-up");
        expect(loop.newTests).toHaveLength(0);
    });

    it("rejects accepting the same candidate twice", async () => {
        const loop = makeHealingLoop({ flowIndex, scenarioIndex, candidates: [candidate], isFirstTurn: false });
        const tool = new HealingAddTestTool();

        const first = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            newTest({ acceptingCandidateId: "cand-1" }),
            loop,
        );
        expect(first.success).toBe(true);

        const second = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            newTest({ acceptingCandidateId: "cand-1" }),
            loop,
        );

        expect(second.success).toBe(false);
        if (second.success) throw new Error("expected failure");
        expect(second.error).toContain("already been accepted");
        expect(loop.newTests).toHaveLength(1);
    });

    it("allows a spontaneous add (no candidate) on the first turn", async () => {
        const loop = makeHealingLoop({ flowIndex, scenarioIndex, isFirstTurn: true });
        const tool = new HealingAddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(tool, newTest(), loop);

        expect(result.success).toBe(true);
        expect(loop.newTests).toHaveLength(1);
    });

    it("rejects a spontaneous add on a later turn", async () => {
        const loop = makeHealingLoop({ flowIndex, scenarioIndex, isFirstTurn: false });
        const tool = new HealingAddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(tool, newTest(), loop);

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toMatch(/first turn/i);
        expect(loop.newTests).toHaveLength(0);
    });
});
