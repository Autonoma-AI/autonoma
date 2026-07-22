import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { executeReadFile } from "../../src/tools/read-file";

describe("tool output caps", () => {
    test("read_file caps output bytes - a one-line minified file must not flood the conversation", async () => {
        const dir = await mkdtemp(join(tmpdir(), "caps-"));
        await writeFile(join(dir, "bundle.js"), "x".repeat(2 * 1024 * 1024));
        const result = await executeReadFile(dir, "bundle.js");
        if ("error" in result && result.error != null) throw new Error(String(result.error));
        if (!("content" in result) || result.content == null) throw new Error("no content");
        expect(result.content.length).toBeLessThan(300 * 1024);
        expect(result.content).toContain("truncated");
    });
});
