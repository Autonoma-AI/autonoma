import { describe, expect, it } from "vitest";
import { buildModifyTestTool } from "../src/tools";
import type { ModifiedTest, ModifiedTestCollector } from "../src/tools/modify-test-tool";
import { executeTool } from "./execute-tool";

const validSlugs = new Set(["healthy-test", "quarantined-test"]);

function emptyCollector(): ModifiedTestCollector {
    return { modifiedTests: [] as ModifiedTest[] };
}

describe("modify_test tool", () => {
    it("records a modification for a valid, non-quarantined slug", async () => {
        const collector = emptyCollector();
        const tool = buildModifyTestTool(collector, validSlugs, new Set());

        const result = await executeTool<{ success: boolean; slug: string }>(tool, {
            slug: "healthy-test",
            newInstruction: "Navigate to /v2/login and ...",
            reasoning: "Route was renamed",
        });

        expect(result.success).toBe(true);
        expect(collector.modifiedTests).toHaveLength(1);
    });

    it("rejects unknown slugs", async () => {
        const collector = emptyCollector();
        const tool = buildModifyTestTool(collector, validSlugs, new Set());

        const result = await executeTool<{ success: boolean; error: string }>(tool, {
            slug: "made-up",
            newInstruction: "...",
            reasoning: "...",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Unknown test slug");
        expect(collector.modifiedTests).toHaveLength(0);
    });

    it("rejects quarantined slugs even when they are otherwise valid", async () => {
        const collector = emptyCollector();
        const tool = buildModifyTestTool(collector, validSlugs, new Set(["quarantined-test"]));

        const result = await executeTool<{ success: boolean; error: string }>(tool, {
            slug: "quarantined-test",
            newInstruction: "...",
            reasoning: "...",
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/quarantined/i);
        expect(collector.modifiedTests).toHaveLength(0);
    });
});
