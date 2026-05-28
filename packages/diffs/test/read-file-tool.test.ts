import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ReadFilesTool } from "../src/agents/tools/codebase/read-files-tool";
import { type ToolEnvelope, executeTool } from "./execute-tool";
import { type TestFixture, createTestFixture } from "./setup-fixture";
import { makeDiffsLoop } from "./test-loops";

type FileResult = { ok: true; content: string } | { ok: false; error: string };

interface ReadFilesOutput {
    results: Record<string, FileResult>;
}

function expectOk(result: FileResult | undefined): { ok: true; content: string } {
    if (result == null || !result.ok) throw new Error(`Expected ok, got: ${JSON.stringify(result)}`);
    return result;
}

describe("read_files tool", () => {
    let fixture: TestFixture;
    let loop: ReturnType<typeof makeDiffsLoop>;

    beforeAll(async () => {
        fixture = await createTestFixture();
        loop = makeDiffsLoop({ workingDirectory: fixture.workingDirectory });
    });

    afterAll(async () => {
        await fixture.cleanup();
    });

    async function read(files: { path: string; startLine?: number; endLine?: number }[]): Promise<ReadFilesOutput> {
        const result = await executeTool<ToolEnvelope<ReadFilesOutput>>(new ReadFilesTool(), { files }, loop);
        if (!result.success) throw new Error(`tool failed: ${result.error}`);
        return result.result;
    }

    it("reads a file", async () => {
        const result = await read([{ path: "src/math.ts" }]);
        const entry = expectOk(result.results["src/math.ts"]);
        expect(entry.content).toContain("export function add");
        expect(entry.content).toContain("export function subtract");
    });

    it("reads a slice of a file", async () => {
        const result = await read([{ path: "src/math.ts", startLine: 5, endLine: 7 }]);
        const entry = expectOk(result.results["src/math.ts"]);
        expect(entry.content).toContain("export function subtract");
        expect(entry.content).not.toContain("export function add");
    });

    it("reads multiple files in a single call, keyed by requested path", async () => {
        const result = await read([{ path: "src/math.ts" }, { path: "src/utils/logger.ts" }]);
        const math = expectOk(result.results["src/math.ts"]);
        const logger = expectOk(result.results["src/utils/logger.ts"]);
        expect(math.content).toContain("export function add");
        expect(logger.content).toContain("class Logger");
    });

    it("reports a per-path error for a missing file without failing the batch", async () => {
        const result = await read([{ path: "does/not/exist.ts" }, { path: "src/math.ts" }]);
        const missing = result.results["does/not/exist.ts"];
        if (missing == null || missing.ok) throw new Error("expected error entry");
        expect(missing.error.length).toBeGreaterThan(0);
        const math = expectOk(result.results["src/math.ts"]);
        expect(math.content).toContain("export function add");
    });
});
