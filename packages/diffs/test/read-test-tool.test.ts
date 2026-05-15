import { describe, expect, it } from "vitest";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { buildReadTestTool } from "../src/tools";
import { executeTool } from "./execute-tool";

const tests: ExistingTestInfo[] = [
    { id: "t1", slug: "login", name: "Login", prompt: "Log in." },
    {
        id: "t2",
        slug: "broken-engine-flow",
        name: "Broken engine flow",
        prompt: "Drag and drop the item.",
        quarantine: { reason: "engine_limitation", issueId: "issue_42" },
    },
];

describe("read_test tool", () => {
    it("returns the test's instruction for a known slug", async () => {
        const tool = buildReadTestTool(tests);

        const result = await executeTool<{ slug: string; name: string; instruction: string }>(tool, {
            slug: "login",
        });

        expect(result).toEqual({ slug: "login", name: "Login", instruction: "Log in.", quarantine: undefined });
    });

    it("includes quarantine info when set", async () => {
        const tool = buildReadTestTool(tests);

        const result = await executeTool<{
            slug: string;
            quarantine?: { reason: string; issueId?: string };
        }>(tool, { slug: "broken-engine-flow" });

        expect(result.quarantine).toEqual({ reason: "engine_limitation", issueId: "issue_42" });
    });

    it("returns an error for an unknown slug", async () => {
        const tool = buildReadTestTool(tests);

        const result = await executeTool<{ error: string }>(tool, { slug: "made-up" });

        expect(result.error).toContain("not found");
    });
});
