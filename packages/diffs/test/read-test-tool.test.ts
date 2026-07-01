import { describe, expect, it } from "vitest";
import { ReadTestsTool } from "../src/agents/tools/lookup/read-tests-tool";
import type { ExistingTestInfo } from "../src/diffs-agent";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { makeDiffsLoop } from "./test-loops";

const tests: ExistingTestInfo[] = [
    { id: "t1", slug: "login", name: "Login", prompt: "Log in." },
    { id: "t2", slug: "checkout", name: "Checkout", prompt: "Buy something." },
];

type ReadResult = {
    results: Record<string, { name: string; instruction: string } | { error: string }>;
};

describe("read_tests tool", () => {
    it("returns the instructions for one or more known slugs in a single call", async () => {
        const loop = makeDiffsLoop({ existingTests: tests });
        const tool = new ReadTestsTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(tool, { slugs: ["login", "checkout"] }, loop);

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result.results.login).toEqual({
            name: "Login",
            instruction: "Log in.",
        });
        expect(result.result.results.checkout).toEqual({
            name: "Checkout",
            instruction: "Buy something.",
        });
    });

    it("reports a per-slug error for unknown slugs while still returning known ones", async () => {
        const loop = makeDiffsLoop({ existingTests: tests });
        const tool = new ReadTestsTool();

        const result = await executeTool<ToolEnvelope<ReadResult>>(tool, { slugs: ["login", "made-up"] }, loop);

        expect(result.success).toBe(true);
        if (!result.success) throw new Error("expected success");
        expect(result.result.results.login).toMatchObject({ name: "Login" });
        const missing = result.result.results["made-up"];
        if (missing == null || !("error" in missing)) throw new Error("expected error entry");
        expect(missing.error).toContain("not found");
    });
});
