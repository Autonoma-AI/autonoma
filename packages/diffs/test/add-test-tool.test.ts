import { describe, expect, it } from "vitest";
import { buildAddTestTool } from "../src/tools";
import type { GeneratedTest } from "../src/tools/add-test-tool";
import { executeTool } from "./execute-tool";

describe("add_test tool", () => {
    it("records a new test suggestion", async () => {
        const collector: { newTests: GeneratedTest[] } = { newTests: [] };
        const tool = buildAddTestTool(collector);

        const result = await executeTool<{ success: boolean; testName: string }>(tool, {
            name: "New user registration",
            instruction:
                "Navigate to /signup, fill in name, email, password, click Create Account, assert welcome page",
            url: "https://app.example.com/signup",
            reasoning: "The diff adds a new signup page that has no test coverage",
        });

        expect(result.success).toBe(true);
        expect(result.testName).toBe("New user registration");
        expect(collector.newTests).toHaveLength(1);
        expect(collector.newTests[0]?.instruction).toContain("/signup");
    });

    it("records multiple tests", async () => {
        const collector: { newTests: GeneratedTest[] } = { newTests: [] };
        const tool = buildAddTestTool(collector);

        await executeTool(tool, {
            name: "Test A",
            instruction: "Do A",
            reasoning: "Reason A",
        });
        await executeTool(tool, {
            name: "Test B",
            instruction: "Do B",
            reasoning: "Reason B",
        });

        expect(collector.newTests).toHaveLength(2);
    });
});
