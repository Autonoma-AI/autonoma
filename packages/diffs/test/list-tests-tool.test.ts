import { describe, expect, it } from "vitest";
import { ListTestsTool } from "../src/agents/tools/lookup/list-tests-tool";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { FlowIndex } from "../src/flow-index";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeDiffsLoop } from "./test-loops";

const tests: ExistingTestInfo[] = [
    { id: "t1", slug: "login", name: "Login", prompt: "Log in." },
    { id: "t2", slug: "checkout", name: "Checkout", prompt: "Add to cart and pay." },
];

const flowIndex = new FlowIndex([
    { id: "auth", name: "auth", testSlugs: ["login"] },
    { id: "checkout", name: "checkout", testSlugs: ["checkout"] },
]);

type ListEntry = {
    slug: string;
    name: string;
};

describe("list_tests tool", () => {
    it("returns slug and name for tests in a flow", async () => {
        const loop = makeDiffsLoop({ flowIndex, existingTests: tests });
        const tool = new ListTestsTool();

        const result = await executeTool<ToolEnvelope<{ tests: ListEntry[]; count: number }>>(
            tool,
            { flowName: "auth" },
            loop,
        );

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result.count).toBe(1);
        expect(result.result.tests[0]).toEqual({ slug: "login", name: "Login" });
    });

    it("returns a fixable failure for an unknown flow", async () => {
        const loop = makeDiffsLoop({ flowIndex, existingTests: tests });
        const tool = new ListTestsTool();

        const result = await executeTool<ToolEnvelope<{ tests: ListEntry[] }>>(tool, { flowName: "made-up" }, loop);

        expect(result.success).toBe(false);
        if (result.success) throw new Error("expected failure");
        expect(result.error).toContain("not found");
    });
});
