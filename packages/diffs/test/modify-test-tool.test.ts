import { describe, expect, it } from "vitest";
import { ModifyTestTool } from "../src/agents/resolution/tools/modify-test-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeResolutionLoop } from "./test-loops";

const failedSlugs = new Set(["healthy-test", "quarantined-test"]);

describe("modify_test tool", () => {
    it("records a modification for a valid, non-quarantined slug", async () => {
        const loop = makeResolutionLoop({ failedSlugs, quarantinedSlugs: new Set() });
        const tool = new ModifyTestTool();

        const result = await executeTool<ToolEnvelope<{ slug: string }>>(
            tool,
            { slug: "healthy-test", newInstruction: "Navigate to /v2/login and ...", reasoning: "Route was renamed" },
            loop,
        );

        expect(result.success).toBe(true);
        expect(loop.modifiedTests).toHaveLength(1);
    });

    it("rejects unknown slugs", async () => {
        const loop = makeResolutionLoop({ failedSlugs, quarantinedSlugs: new Set() });
        const tool = new ModifyTestTool();

        const result = await executeTool<ToolEnvelope<{ slug: string }>>(
            tool,
            { slug: "made-up", newInstruction: "...", reasoning: "..." },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("Unknown test slug");
        expect(loop.modifiedTests).toHaveLength(0);
    });

    it("rejects quarantined slugs even when they are otherwise valid", async () => {
        const loop = makeResolutionLoop({ failedSlugs, quarantinedSlugs: new Set(["quarantined-test"]) });
        const tool = new ModifyTestTool();

        const result = await executeTool<ToolEnvelope<{ slug: string }>>(
            tool,
            { slug: "quarantined-test", newInstruction: "...", reasoning: "..." },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toMatch(/quarantined/i);
        expect(loop.modifiedTests).toHaveLength(0);
    });
});
