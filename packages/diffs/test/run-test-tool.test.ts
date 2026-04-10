import { describe, expect, it, vi } from "vitest";
import type { DiffsAgentCallbacks } from "../src/callbacks";
import type { TestRunResult } from "../src/diffs-agent";
import { buildRunTestTool } from "../src/tools/run-test-tool";
import { executeTool } from "./execute-tool";

const VALID_SLUGS = new Set(["login-flow", "checkout-flow", "settings-page", "user-profile"]);

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
        const tool = buildRunTestTool(callbacks, completedRuns, VALID_SLUGS);

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
        const tool = buildRunTestTool(callbacks, completedRuns, VALID_SLUGS);

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
        const tool = buildRunTestTool(callbacks, completedRuns, VALID_SLUGS);

        const result = await executeTool<TestRunResult[]>(tool, { slugs: ["checkout-flow"] });

        expect(result[0]!.success).toBe(false);
        expect(result[0]!.finishReason).toBe("error");
        expect(completedRuns.has("checkout-flow")).toBe(true);
    });

    it("returns error with suggestions when all slugs are invalid", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>();
        const tool = buildRunTestTool(callbacks, completedRuns, VALID_SLUGS);

        const result = await executeTool<{ error: string }>(tool, { slugs: ["logn-flow", "chekout-flow"] });

        expect(result.error).toContain("logn-flow");
        expect(result.error).toContain("chekout-flow");
        expect(result.error).toContain("login-flow");
        expect(result.error).toContain("checkout-flow");
        expect(callbacks.triggerTestsAndWait).not.toHaveBeenCalled();
        expect(completedRuns.size).toBe(0);
    });

    it("returns error without running any tests when mix of valid and invalid slugs", async () => {
        const callbacks = createMockCallbacks([{ slug: "login-flow", success: true }]);
        const completedRuns = new Set<string>();
        const tool = buildRunTestTool(callbacks, completedRuns, VALID_SLUGS);

        const result = await executeTool<{ error: string }>(tool, {
            slugs: ["login-flow", "made-up-slug"],
        });

        expect(result.error).toContain("made-up-slug");
        expect(callbacks.triggerTestsAndWait).not.toHaveBeenCalled();
        expect(completedRuns.size).toBe(0);
    });

    it("rejects file paths as slugs", async () => {
        const callbacks = createMockCallbacks();
        const completedRuns = new Set<string>();
        const tool = buildRunTestTool(callbacks, completedRuns, VALID_SLUGS);

        const result = await executeTool<{ error: string }>(tool, {
            slugs: ["autonoma/qa-tests/login-flow.md"],
        });

        expect(result.error).toContain("autonoma/qa-tests/login-flow.md");
        expect(result.error).toContain("Do NOT use file paths");
        expect(callbacks.triggerTestsAndWait).not.toHaveBeenCalled();
    });
});
