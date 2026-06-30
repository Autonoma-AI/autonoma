import { describe, expect, it } from "vitest";
import { createDiffStatTool, createGetTestPlanTool } from "../../src/select/tools";
import { createToolBudget } from "../../src/tool-output";

const TOOL_OPTIONS = { toolCallId: "test-call", messages: [] };

describe("selector tools", () => {
    it("get_test_plan returns the full plan for a slug, or a clear miss", async () => {
        const catalog = {
            getSnapshotPlan: async (_snapshotId: string, slug: string) =>
                slug === "login" ? "Setup: on the page\nSteps:\n1. click the button" : undefined,
        };
        const found = await createGetTestPlanTool(catalog, "snap1", createToolBudget()).execute?.(
            { slug: "login" },
            TOOL_OPTIONS,
        );
        expect(found).toContain("Steps:");
        const missing = await createGetTestPlanTool(catalog, "snap1", createToolBudget()).execute?.(
            { slug: "nope" },
            TOOL_OPTIONS,
        );
        expect(missing).toContain("no plan found");
    });

    it("diff_stat reads the changed-files summary from the codebase", async () => {
        const codebase = {
            readFile: async () => "",
            grep: async () => "",
            diff: async () => "",
            diffStat: async () => "a.ts | 3 +++",
        };
        const result = await createDiffStatTool(codebase, createToolBudget()).execute?.({}, TOOL_OPTIONS);
        expect(result).toContain("a.ts | 3 +++");
    });
});
