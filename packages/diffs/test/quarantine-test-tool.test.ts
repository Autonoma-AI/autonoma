import { describe, expect, it, vi } from "vitest";
import type { DiffsAgentCallbacks } from "../src/callbacks";
import { buildQuarantineTestTool } from "../src/tools/quarantine-test-tool";
import { createEmptyCollector } from "./create-collector";
import { executeTool } from "./execute-tool";

function createMockCallbacks(): DiffsAgentCallbacks {
    return {
        triggerTestsAndWait: vi.fn(),
        quarantineTest: vi.fn().mockResolvedValue(undefined),
        modifyTest: vi.fn(),
        updateSkill: vi.fn(),
        reportBug: vi.fn(),
    };
}

describe("quarantine_test tool", () => {
    it("rejects if test has not been run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>();
        const tool = buildQuarantineTestTool(callbacks, completedRuns, createEmptyCollector());

        const result = await executeTool<{ error: string }>(tool, {
            slug: "login-flow",
            testName: "Test 1",
            reasoning: "Flow was deleted",
        });

        expect(result.error).toContain("has not been run yet");
        expect(callbacks.quarantineTest).not.toHaveBeenCalled();
    });

    it("quarantines a test that has been run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>(["login-flow"]);
        const collector = createEmptyCollector();
        const tool = buildQuarantineTestTool(callbacks, completedRuns, collector);

        const result = await executeTool<{ success: boolean }>(tool, {
            slug: "login-flow",
            testName: "Test 1",
            reasoning: "The settings page was removed",
        });

        expect(result.success).toBe(true);
        expect(callbacks.quarantineTest).toHaveBeenCalledWith("login-flow");
        expect(collector.testActions).toHaveLength(1);
        expect(collector.testActions[0]?.type).toBe("quarantine");
    });

    it("rejects a different test that was not run", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>(["login-flow"]);
        const tool = buildQuarantineTestTool(callbacks, completedRuns, createEmptyCollector());

        const result = await executeTool<{ error: string }>(tool, {
            slug: "checkout-flow",
            testName: "Test 2",
            reasoning: "Flow was deleted",
        });

        expect(result.error).toContain("checkout-flow");
        expect(callbacks.quarantineTest).not.toHaveBeenCalled();
    });
});
