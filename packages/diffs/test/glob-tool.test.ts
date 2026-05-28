import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GlobTool } from "../src/agents/tools/codebase/glob-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { type TestFixture, createTestFixture } from "./setup-fixture";
import { makeDiffsLoop } from "./test-loops";

interface GlobOutput {
    matches: string[];
    count: number;
}

describe("glob tool", () => {
    let fixture: TestFixture;
    let loop: ReturnType<typeof makeDiffsLoop>;

    beforeAll(async () => {
        fixture = await createTestFixture();
        loop = makeDiffsLoop({ workingDirectory: fixture.workingDirectory });
    });

    afterAll(async () => {
        await fixture.cleanup();
    });

    async function runGlob(input: { pattern: string; cwd?: string }): Promise<GlobOutput> {
        const result = await executeTool<ToolEnvelope<GlobOutput>>(new GlobTool(), input, loop);
        if (!result.success) throw new Error(`tool failed: ${result.error}`);
        return result.result;
    }

    it("finds all TypeScript files", async () => {
        const result = await runGlob({ pattern: "**/*.ts" });
        expect(result.count).toBe(3);
        expect(result.matches).toContain("src/index.ts");
        expect(result.matches).toContain("src/math.ts");
        expect(result.matches).toContain("src/utils/logger.ts");
    });

    it("finds files in a specific directory", async () => {
        const result = await runGlob({ pattern: "src/utils/*.ts" });
        expect(result.count).toBe(1);
        expect(result.matches).toContain("src/utils/logger.ts");
    });

    it("finds markdown files", async () => {
        const result = await runGlob({ pattern: "*.md" });
        expect(result.count).toBe(1);
        expect(result.matches).toContain("README.md");
    });

    it("returns empty for non-matching pattern", async () => {
        const result = await runGlob({ pattern: "**/*.py" });
        expect(result.count).toBe(0);
        expect(result.matches).toEqual([]);
    });

    it("supports custom cwd", async () => {
        const result = await runGlob({ pattern: "*.ts", cwd: `${fixture.workingDirectory}/src/utils` });
        expect(result.count).toBe(1);
        expect(result.matches).toContain("logger.ts");
    });
});
