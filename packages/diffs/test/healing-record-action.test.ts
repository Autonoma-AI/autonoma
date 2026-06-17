import { describe, expect, it } from "vitest";
import { UpdatePlanTool } from "../src/agents/healing/tools/update-plan-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeHealingLoop } from "./test-loops";

const FAILING_TEST_CASE_ID = "tc-failing-1";

function updateInput(testCaseId: string) {
    return {
        planId: "plan-1",
        testCaseId,
        newPrompt: "do the thing more reliably",
        reasoning: "the previous plan was too vague",
    };
}

describe("healing recordHealingAction testCaseId gate", () => {
    it("records an action that targets one of the iteration's failing test cases", async () => {
        const loop = makeHealingLoop({
            failureKeysByTestCaseId: new Map([[FAILING_TEST_CASE_ID, "fk-1"]]),
            failureKeys: new Set(["fk-1"]),
        });
        const tool = new UpdatePlanTool();

        const result = await executeTool<ToolEnvelope<{ testCaseId: string }>>(
            tool,
            updateInput(FAILING_TEST_CASE_ID),
            loop,
        );

        expect(result.success).toBe(true);
        expect(loop.actions).toHaveLength(1);
        expect(loop.actions[0]?.testCaseId).toBe(FAILING_TEST_CASE_ID);
    });

    it("rejects a malformed testCaseId (valid id with extra text pasted on) without recording it", async () => {
        const loop = makeHealingLoop({
            failureKeysByTestCaseId: new Map([[FAILING_TEST_CASE_ID, "fk-1"]]),
            failureKeys: new Set(["fk-1"]),
        });
        const tool = new UpdatePlanTool();

        // Mirrors the production incident: a valid cuid with markdown/extra ids
        // jammed onto the end of the tool-call argument.
        const malformed = `${FAILING_TEST_CASE_ID}}<br/><br/>### Plan 007<br/>- Test Case ID: tc-failing-2`;
        const result = await executeTool<ToolEnvelope<{ testCaseId: string }>>(tool, updateInput(malformed), loop);

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("not one of this iteration's failing test cases");
        expect(loop.actions).toHaveLength(0);
    });

    it("rejects a testCaseId that belongs to a different iteration/snapshot", async () => {
        const loop = makeHealingLoop({
            failureKeysByTestCaseId: new Map([[FAILING_TEST_CASE_ID, "fk-1"]]),
            failureKeys: new Set(["fk-1"]),
        });
        const tool = new UpdatePlanTool();

        const result = await executeTool<ToolEnvelope<{ testCaseId: string }>>(
            tool,
            updateInput("tc-from-another-suite"),
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("tc-from-another-suite");
        expect(loop.actions).toHaveLength(0);
    });
});
