import { describe, expect, it } from "vitest";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import { buildListTestsTool } from "../src/tools";
import { executeTool } from "./execute-tool";

const tests: ExistingTestInfo[] = [
    { id: "t1", slug: "login", name: "Login", prompt: "Log in." },
    {
        id: "t2",
        slug: "broken-checkout",
        name: "Broken checkout",
        prompt: "Add to cart and pay.",
        quarantine: { reason: "application_bug", bugId: "bug_123" },
    },
];

const flowIndex = new FlowIndex([
    { id: "auth", name: "auth", testSlugs: ["login"] },
    { id: "checkout", name: "checkout", testSlugs: ["broken-checkout"] },
]);

describe("list_tests tool", () => {
    it("returns slug and name for tests in a flow", async () => {
        const tool = buildListTestsTool(flowIndex, tests);

        const result = await executeTool<{ tests: { slug: string; name: string }[]; count: number }>(tool, {
            flowName: "auth",
        });

        expect(result.count).toBe(1);
        expect(result.tests[0]).toEqual({ slug: "login", name: "Login", quarantine: undefined });
    });

    it("includes quarantine info when set", async () => {
        const tool = buildListTestsTool(flowIndex, tests);

        const result = await executeTool<{
            tests: {
                slug: string;
                name: string;
                quarantine?: { reason: string; bugId?: string; issueId?: string };
            }[];
        }>(tool, { flowName: "checkout" });

        expect(result.tests[0]?.quarantine).toEqual({ reason: "application_bug", bugId: "bug_123" });
    });

    it("returns an error for an unknown flow", async () => {
        const tool = buildListTestsTool(flowIndex, tests);

        const result = await executeTool<{ error: string }>(tool, { flowName: "made-up" });

        expect(result.error).toContain("not found");
    });
});
