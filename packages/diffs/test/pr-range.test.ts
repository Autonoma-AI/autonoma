import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type PrRange, readPrChangedFiles, readPrCommitSubjects, readPrDiffStat } from "../src/pr-range";

const execFileAsync = promisify(execFile);

let range: PrRange;

/**
 * A real two-commit repo, because that is what these functions are: `git` invocations against a clone. The
 * head commit touches a source file, a lockfile and a build artifact, so the reads are exercised against the
 * mix of noise and signal a real PR carries rather than asserted in the abstract.
 */
beforeAll(async () => {
    const root = await mkdtemp(join(tmpdir(), "pr-range-"));
    const git = (...args: string[]) => execFileAsync("git", args, { cwd: root });

    await git("init", "--initial-branch", "main");
    await git("config", "user.email", "test@example.com");
    await git("config", "user.name", "Test");

    await fs.writeFile(join(root, "app.ts"), "export const gate = false;\n");
    await git("add", ".");
    await git("commit", "-m", "chore: base commit");
    const { stdout: baseSha } = await git("rev-parse", "HEAD");

    await fs.writeFile(join(root, "app.ts"), "export const gate = true;\n");
    await fs.writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.mkdir(join(root, "dist"));
    await fs.writeFile(join(root, "dist", "bundle.js"), "console.log('built');\n");
    await fs.mkdir(join(root, "pkg"));
    await fs.writeFile(join(root, "pkg", "pnpm-lock.yaml"), "nested lockfile\n");
    await git("add", ".");
    await git("commit", "-m", "feat(app): open the gate");
    const { stdout: headSha } = await git("rev-parse", "HEAD");

    range = { root, baseSha: baseSha.trim(), headSha: headSha.trim() };
});

afterAll(async () => {
    if (range != null) await rm(range.root, { recursive: true, force: true });
});

describe("readPrDiffStat", () => {
    it("summarizes every changed file, noise included", async () => {
        const stat = await readPrDiffStat(range);

        expect(stat).toContain("app.ts");
        expect(stat).toContain("4 files changed");
    });
});

describe("readPrChangedFiles", () => {
    it("lists the range's changed paths with no blank entries", async () => {
        const files = await readPrChangedFiles(range);

        expect(files).toEqual(["app.ts", "dist/bundle.js", "pkg/pnpm-lock.yaml", "pnpm-lock.yaml"]);
    });
});

describe("readPrCommitSubjects", () => {
    it("returns only the subjects of commits in the range", async () => {
        const subjects = await readPrCommitSubjects(range);

        expect(subjects).toBe("feat(app): open the gate");
    });
});
