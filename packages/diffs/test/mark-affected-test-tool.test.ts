import { describe, expect, it } from "vitest";
import { buildMarkAffectedTestTool } from "../src/tools";
import type { AffectedTest } from "../src/tools/mark-affected-test-tool";
import { executeTool } from "./execute-tool";

const validSlugs = new Set(["healthy-test", "quarantined-test"]);

describe("mark_affected_test tool", () => {
    it("records an affected test for a valid, non-quarantined slug", async () => {
        const collector: { affectedTests: AffectedTest[] } = { affectedTests: [] };
        const tool = buildMarkAffectedTestTool(collector, validSlugs, new Set());

        const result = await executeTool<{ success: boolean; slug: string }>(tool, {
            slug: "healthy-test",
            testName: "Healthy test",
            reasoning: "Diff touches the flow this test exercises",
        });

        expect(result.success).toBe(true);
        expect(collector.affectedTests).toHaveLength(1);
        expect(collector.affectedTests[0]?.affectedReason).toBe("code_change");
    });

    it("rejects unknown slugs", async () => {
        const collector: { affectedTests: AffectedTest[] } = { affectedTests: [] };
        const tool = buildMarkAffectedTestTool(collector, validSlugs, new Set());

        const result = await executeTool<{ success: boolean; error: string }>(tool, {
            slug: "made-up",
            testName: "Made up",
            reasoning: "...",
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("Invalid slug");
        expect(collector.affectedTests).toHaveLength(0);
    });

    it("rejects quarantined slugs even when they are otherwise valid", async () => {
        const collector: { affectedTests: AffectedTest[] } = { affectedTests: [] };
        const tool = buildMarkAffectedTestTool(collector, validSlugs, new Set(["quarantined-test"]));

        const result = await executeTool<{ success: boolean; error: string }>(tool, {
            slug: "quarantined-test",
            testName: "Quarantined test",
            reasoning: "Diff touches the flow",
        });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/quarantined/i);
        expect(collector.affectedTests).toHaveLength(0);
    });
});
