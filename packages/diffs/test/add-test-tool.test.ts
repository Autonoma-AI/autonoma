import { describe, expect, it } from "vitest";
import { AddTestTool } from "../src/agents/resolution/tools/add-test-tool";
import { FlowIndex } from "../src/flow-index";
import { ScenarioIndex } from "../src/scenario-index";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeResolutionLoop } from "./test-loops";

const flowIndex = new FlowIndex([{ id: "auth-folder", name: "auth", testSlugs: [] }]);
const scenarioIndex = new ScenarioIndex([
    { id: "scenario-admin", name: "authenticated-admin", description: "Logged-in admin user" },
]);

function newLoop() {
    return makeResolutionLoop({ flowIndex, scenarioIndex });
}

describe("add_test tool", () => {
    it("records a new test suggestion", async () => {
        const loop = newLoop();
        const tool = new AddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            {
                name: "New user registration",
                folderName: "auth",
                instruction:
                    "Navigate to /signup, fill in name, email, password, click Create Account, assert welcome page",
                url: "https://app.example.com/signup",
                reasoning: "The diff adds a new signup page that has no test coverage",
            },
            loop,
        );

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result.testName).toBe("New user registration");
        expect(loop.newTests).toHaveLength(1);
        expect(loop.newTests[0]?.instruction).toContain("/signup");
    });

    it("records multiple tests", async () => {
        const loop = newLoop();
        const tool = new AddTestTool();

        await executeTool(
            tool,
            { name: "Test A", folderName: "auth", instruction: "Do A", reasoning: "Reason A" },
            loop,
        );
        await executeTool(
            tool,
            { name: "Test B", folderName: "auth", instruction: "Do B", reasoning: "Reason B" },
            loop,
        );

        expect(loop.newTests).toHaveLength(2);
    });

    it("records scenarioId when provided", async () => {
        const loop = newLoop();
        const tool = new AddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            {
                name: "Admin dashboard",
                folderName: "auth",
                instruction: "Visit /admin and assert the dashboard loads",
                reasoning: "The diff adds an admin-only dashboard",
                scenarioId: "scenario-admin",
            },
            loop,
        );

        expect(result.success).toBe(true);
        expect(loop.newTests[0]?.scenarioId).toBe("scenario-admin");
    });

    it("rejects an unknown scenarioId", async () => {
        const loop = newLoop();
        const tool = new AddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            {
                name: "Broken",
                folderName: "auth",
                instruction: "Do something",
                reasoning: "Reason",
                scenarioId: "does-not-exist",
            },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("does-not-exist");
        expect(loop.newTests).toHaveLength(0);
    });

    it("rejects an unknown folder", async () => {
        const loop = newLoop();
        const tool = new AddTestTool();

        const result = await executeTool<ToolEnvelope<{ testName: string }>>(
            tool,
            { name: "Broken", folderName: "nonexistent", instruction: "Do something", reasoning: "Reason" },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("nonexistent");
    });
});
