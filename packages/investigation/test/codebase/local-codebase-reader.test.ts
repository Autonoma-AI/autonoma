import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalCodebaseReader } from "../../src/codebase/local-codebase-reader";

const execFileAsync = promisify(execFile);

describe("LocalCodebaseReader", () => {
    let root: string;
    let reader: LocalCodebaseReader;

    beforeAll(async () => {
        root = await mkdtemp(join(tmpdir(), "investigation-repo-"));
        const git = (args: string[]) => execFileAsync("git", args, { cwd: root });
        await git(["init", "-q"]);
        await git(["config", "user.email", "test@example.com"]);
        await git(["config", "user.name", "Test"]);
        await writeFile(join(root, "app.ts"), "export const x = 1;\nexport const y = 2;\n");
        await git(["add", "."]);
        await git(["commit", "-q", "-m", "base"]);
        const baseSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
        await writeFile(join(root, "app.ts"), "export const x = 100;\nexport const y = 2;\n");
        await git(["add", "."]);
        await git(["commit", "-q", "-m", "change x"]);
        const headSha = (await git(["rev-parse", "HEAD"])).stdout.trim();
        reader = new LocalCodebaseReader(root, baseSha, headSha);
    });

    afterAll(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("reads a file's line range", async () => {
        expect(await reader.readFile("app.ts", 1, 1)).toContain("x = 100");
    });

    it("returns the patch between base and head", async () => {
        const patch = await reader.diff();
        expect(patch).toContain("-export const x = 1;");
        expect(patch).toContain("+export const x = 100;");
    });

    it("returns the changed-files summary", async () => {
        expect(await reader.diffStat()).toContain("app.ts");
    });

    it("greps tracked files for a pattern (and returns empty on no match)", async () => {
        const hit = await reader.grep("const x");
        expect(hit).toContain("app.ts");
        expect(hit).toContain("x = 100");
        expect(await reader.grep("definitely-not-present-anywhere")).toBe("");
    });

    it("rejects a path that escapes the repository root", async () => {
        await expect(reader.readFile("../../etc/passwd", 1, 1)).rejects.toThrow(/escapes the repository root/);
    });
});
