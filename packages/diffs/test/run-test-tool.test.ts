import { describe, expect, it, vi } from "vitest";
import type { DiffsAgentCallbacks } from "../src/callbacks";
import type { TestRunResult } from "../src/diffs-agent";
import { buildRunTestTool } from "../src/tools/run-test-tool";
import { executeTool } from "./execute-tool";

function createMockCallbacks(results?: Partial<TestRunResult>[]): DiffsAgentCallbacks {
    const defaultResults: TestRunResult[] = [
        {
            slug: "login-flow",
            testName: "Login flow",
            success: true,
            finishReason: "success",
            reasoning: "All assertions passed",
            stepDescriptions: ["Navigated to /login", "Entered credentials", "Clicked Sign In"],
            screenshotUrls: [],
        },
    ];

    const mockResults =
        results != null
            ? results.map((r) => ({
                  slug: "login-flow",
                  testName: "Login flow",
                  success: true,
                  finishReason: "success" as const,
                  reasoning: "All assertions passed",
                  stepDescriptions: [],
                  screenshotUrls: [],
                  ...r,
              }))
            : defaultResults;

    return {
        triggerTestsAndWait: vi.fn().mockResolvedValue(mockResults),
        quarantineTest: vi.fn(),
        modifyTest: vi.fn(),
        updateSkill: vi.fn(),
        reportBug: vi.fn(),
    };
}

describe("run_test tool", () => {
    it("triggers batch test execution and returns results", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>();
        const tool = buildRunTestTool(callbacks, completedRuns);

        const result = await executeTool<TestRunResult[]>(tool, { slugs: ["login-flow"] });

        expect(callbacks.triggerTestsAndWait).toHaveBeenCalledWith(["login-flow"]);
        expect(result).toHaveLength(1);
        expect(result[0]!.slug).toBe("login-flow");
        expect(result[0]!.success).toBe(true);
    });

    it("adds all test slugs to completedRuns set", async () => {
        const callbacks = createMockCallbacks([
            { slug: "login-flow", success: true },
            { slug: "checkout-flow", success: false },
        ]);
        const completedRuns = new Set<string>();
        const tool = buildRunTestTool(callbacks, completedRuns);

        await executeTool(tool, { slugs: ["login-flow", "checkout-flow"] });

        expect(completedRuns.has("login-flow")).toBe(true);
        expect(completedRuns.has("checkout-flow")).toBe(true);
    });

    it("returns failed test results", async () => {
        const callbacks = createMockCallbacks([
            {
                slug: "checkout-flow",
                success: false,
                finishReason: "error",
                reasoning: "Button not found",
            },
        ]);
        const completedRuns = new Set<string>();
        const tool = buildRunTestTool(callbacks, completedRuns);

        const result = await executeTool<TestRunResult[]>(tool, { slugs: ["checkout-flow"] });

        expect(result[0]!.success).toBe(false);
        expect(result[0]!.finishReason).toBe("error");
        expect(completedRuns.has("checkout-flow")).toBe(true);
    });
});
