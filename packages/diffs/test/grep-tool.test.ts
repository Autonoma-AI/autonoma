import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GrepTool } from "../src/agents/tools/codebase/grep-tool";
import type { GrepHit } from "../src/codebase";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { type TestFixture, createTestFixture } from "./setup-fixture";
import { makeDiffsLoop } from "./test-loops";

interface GrepOutput {
    hits: GrepHit[];
}

describe("grep tool", () => {
    let fixture: TestFixture;
    let loop: ReturnType<typeof makeDiffsLoop>;

    beforeAll(async () => {
        fixture = await createTestFixture();
        loop = makeDiffsLoop({ workingDirectory: fixture.workingDirectory });
    });

    afterAll(async () => {
        await fixture.cleanup();
    });

    async function runGrep(input: { pattern: string; glob?: string; maxResults?: number }): Promise<GrepOutput> {
        const result = await executeTool<ToolEnvelope<GrepOutput>>(new GrepTool(), input, loop);
        if (!result.success) throw new Error(`tool failed: ${result.error}`);
        return result.result;
    }

    it("finds a function definition", async () => {
        const result = await runGrep({ pattern: "export function add" });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]?.path).toContain("math.ts");
        expect(result.hits[0]?.match).toContain("export function add");
    });

    it("finds multiple matches across files", async () => {
        const result = await runGrep({ pattern: "export" });
        expect(result.hits.length).toBeGreaterThanOrEqual(4);
    });

    it("filters by glob pattern", async () => {
        const result = await runGrep({ pattern: "export", glob: "**/utils/**" });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]?.path).toContain("logger.ts");
    });

    it("returns empty for non-matching pattern", async () => {
        const result = await runGrep({ pattern: "this_pattern_does_not_exist_anywhere" });
        expect(result.hits).toEqual([]);
    });

    it("supports regex patterns", async () => {
        const result = await runGrep({ pattern: "function \\w+\\(a: number" });
        expect(result.hits).toHaveLength(2);
    });

    it("includes line numbers in hits", async () => {
        const result = await runGrep({ pattern: "export function subtract" });
        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]?.line).toBeGreaterThan(0);
        expect(result.hits[0]?.match).toContain("export function subtract");
    });
});
