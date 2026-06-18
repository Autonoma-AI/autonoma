import { Codebase, FlowIndex, HealingAgent, type HealingInput, ScenarioIndex } from "@autonoma/diffs";
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

/**
 * A mock model that finishes immediately by calling `finish`, and records the
 * tool set it was offered on each call. With no failures and no candidates the
 * `finish` call succeeds on the first step, so the run does exactly one model
 * call - and `doGenerateCalls[0].tools` is the tool set the agent exposed for
 * that turn.
 */
function finishImmediatelyModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: [
                {
                    type: "tool-call",
                    toolCallId: "call-finish",
                    toolName: "finish",
                    input: JSON.stringify({ reasoning: "nothing to do" }),
                },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage: {
                inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
            warnings: [],
        }),
    });
}

/** A minimal, failure-free, candidate-free input for the given turn. */
function turnInput(iteration: number, maxIterations: number): Omit<HealingInput, "codebase"> {
    return {
        iteration,
        maxIterations,
        snapshotId: "snap-1",
        applicationId: "app-1",
        organizationId: "org-1",
        priorActions: [],
        failures: [],
        candidates: [],
        flowIndex: new FlowIndex([{ id: "all", name: "All Tests", testSlugs: [] }]),
        existingTests: [],
        planAuthoring: { scenarios: new ScenarioIndex([]), flows: [] },
        change: { baseSha: "base", headSha: "head" },
        analysisReasoning: "something changed",
    };
}

/** Run the agent for one turn and return the tool names it offered the model. */
async function toolsOfferedOnTurn(iteration: number, maxIterations: number): Promise<string[]> {
    const model = finishImmediatelyModel();
    const agent = new HealingAgent({ model });
    await agent.run({ ...turnInput(iteration, maxIterations), codebase: new Codebase(process.cwd()) });

    const call = model.doGenerateCalls[0];
    expect(call).toBeDefined();
    return (call?.tools ?? []).map((t) => t.name);
}

describe("HealingAgent final-turn tool gating", () => {
    it("offers the retry tools on a non-final turn", async () => {
        const tools = await toolsOfferedOnTurn(1, 4);

        // Retry tools present...
        expect(tools).toContain("update_plan");
        expect(tools).toContain("add_test");
        // ...alongside the terminal tools.
        expect(tools).toContain("report_bug");
        expect(tools).toContain("report_engine_limitation");
        expect(tools).toContain("remove_test");
    });

    it("withholds the retry tools on the final turn, keeping the terminal tools", async () => {
        const tools = await toolsOfferedOnTurn(4, 4);

        // The whole point: no way to author a plan change that would spawn a
        // dangling iteration N+1.
        expect(tools).not.toContain("update_plan");
        expect(tools).not.toContain("add_test");
        // Triage is still fully possible.
        expect(tools).toContain("report_bug");
        expect(tools).toContain("report_engine_limitation");
        expect(tools).toContain("remove_test");
    });

    it("rejects a final turn that carries candidates - add_test would be unavailable to graduate them", async () => {
        const input: Omit<HealingInput, "codebase"> = {
            ...turnInput(4, 4),
            candidates: [{ candidateId: "cand-1", name: "New flow", instruction: "cover it", reasoning: "untested" }],
        };
        const agent = new HealingAgent({ model: finishImmediatelyModel() });

        await expect(agent.run({ ...input, codebase: new Codebase(process.cwd()) })).rejects.toThrow(
            /add_test is withheld on the final turn/,
        );
    });
});
