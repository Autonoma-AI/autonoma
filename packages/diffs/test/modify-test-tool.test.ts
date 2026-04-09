import { describe, expect, it, vi } from "vitest";
import type { DiffsAgentCallbacks } from "../src/callbacks";
import { buildModifyTestTool } from "../src/tools/modify-test-tool";
import { createEmptyCollector } from "./create-collector";
import { executeTool } from "./execute-tool";

function createMockCallbacks(): DiffsAgentCallbacks {
    return {
        triggerTestsAndWait: vi.fn(),
        quarantineTest: vi.fn(),
        modifyTest: vi.fn().mockResolvedValue(undefined),
        updateSkill: vi.fn(),
        reportBug: vi.fn(),
    };
}

describe("modify_test tool", () => {
    it("rejects if test has not been run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>();
        const tool = buildModifyTestTool(callbacks, completedRuns, createEmptyCollector());

        const result = await executeTool<{ error: string }>(tool, {
            slug: "login-flow",
            testName: "Test 1",
            reasoning: "Button text changed",
            newInstruction: "Click the 'Submit Order' button instead of 'Place Order'",
        });

        expect(result.error).toContain("has not been run yet");
        expect(callbacks.modifyTest).not.toHaveBeenCalled();
    });

    it("modifies a test that has been run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>(["login-flow"]);
        const collector = createEmptyCollector();
        const tool = buildModifyTestTool(callbacks, completedRuns, collector);

        const result = await executeTool<{ success: boolean }>(tool, {
            slug: "login-flow",
            testName: "Test 1",
            reasoning: "Button text changed from 'Place Order' to 'Submit Order'",
            newInstruction: "Navigate to checkout, fill in details, click 'Submit Order'",
        });

        expect(result.success).toBe(true);
        expect(callbacks.modifyTest).toHaveBeenCalledWith(
            "login-flow",
            "Navigate to checkout, fill in details, click 'Submit Order'",
        );
        expect(collector.testActions).toHaveLength(1);
        expect(collector.testActions[0]?.type).toBe("modify");
    });
});
