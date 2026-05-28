import { describe, expect, it } from "vitest";
import { MarkAffectedTestTool } from "../src/agents/diffs/tools/mark-affected-test-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeDiffsLoop } from "./test-loops";

const validSlugs = new Set(["healthy-test", "quarantined-test"]);

describe("mark_affected_test tool", () => {
    it("records an affected test for a valid, non-quarantined slug", async () => {
        const loop = makeDiffsLoop({ validSlugs, quarantinedSlugs: new Set() });
        const tool = new MarkAffectedTestTool();

        const result = await executeTool<ToolEnvelope<{ slug: string }>>(
            tool,
            { slug: "healthy-test", testName: "Healthy test", reasoning: "Diff touches the flow this test exercises" },
            loop,
        );

        expect(result.success).toBe(true);
        expect(loop.affectedTests).toHaveLength(1);
        expect(loop.affectedTests[0]?.affectedReason).toBe("code_change");
    });

    it("rejects unknown slugs", async () => {
        const loop = makeDiffsLoop({ validSlugs, quarantinedSlugs: new Set() });
        const tool = new MarkAffectedTestTool();

        const result = await executeTool<ToolEnvelope<{ slug: string }>>(
            tool,
            { slug: "made-up", testName: "Made up", reasoning: "..." },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("Invalid slug");
        expect(loop.affectedTests).toHaveLength(0);
    });

    it("rejects quarantined slugs even when they are otherwise valid", async () => {
        const loop = makeDiffsLoop({ validSlugs, quarantinedSlugs: new Set(["quarantined-test"]) });
        const tool = new MarkAffectedTestTool();

        const result = await executeTool<ToolEnvelope<{ slug: string }>>(
            tool,
            { slug: "quarantined-test", testName: "Quarantined test", reasoning: "Diff touches the flow" },
            loop,
        );

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toMatch(/quarantined/i);
        expect(loop.affectedTests).toHaveLength(0);
    });
});
