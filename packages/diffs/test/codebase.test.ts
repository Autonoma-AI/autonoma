import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Codebase } from "../src/codebase";

const execFileAsync = promisify(execFile);

let fixtureDir: string;
let outsideFile: string;

beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "codebase-fixture-"));
    await fs.mkdir(join(fixtureDir, "src"));
    await fs.writeFile(
        join(fixtureDir, "src", "login.tsx"),
        "import React from 'react';\nexport function LoginButton() {\n  return <button>Sign In</button>;\n}\n",
    );
    await fs.writeFile(
        join(fixtureDir, "src", "checkout.tsx"),
        "export function Checkout() {\n  return <div>Pay now</div>;\n}\n",
    );
    await fs.writeFile(join(fixtureDir, "README.md"), "# Test fixture\n");

    // A file outside the fixture, with a symlink pointing to it. Used to
    // confirm the codebase happily follows symlinks outside the clone -
    // the reviewer agent is trusted, we don't sandbox navigation.
    outsideFile = join(tmpdir(), "codebase-outside.txt");
    await fs.writeFile(outsideFile, "value-from-outside\n");
    await symlink(outsideFile, join(fixtureDir, "outside-link.txt"));

    await execFileAsync("git", ["init"], { cwd: fixtureDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: fixtureDir });
    await execFileAsync("git", ["config", "user.name", "Test"], { cwd: fixtureDir });
    await execFileAsync("git", ["add", "."], { cwd: fixtureDir });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: fixtureDir });
});

afterAll(async () => {
    if (fixtureDir != null) await fs.rm(fixtureDir, { recursive: true, force: true });
    if (outsideFile != null) await fs.rm(outsideFile, { force: true });
});

async function makeCodebase(): Promise<Codebase> {
    const targetDir = await mkdtemp(join(tmpdir(), "codebase-target-"));
    await fs.cp(fixtureDir, targetDir, { recursive: true });
    return new Codebase(targetDir);
}

describe("Codebase", () => {
    it("readFile returns the full file by default and slices by line range", async () => {
        const codebase = await makeCodebase();
        try {
            const fullContent = await codebase.readFile("src/login.tsx");
            expect(fullContent).toContain("Sign In");

            const slice = await codebase.readFile("src/login.tsx", { startLine: 2, endLine: 2 });
            expect(slice.trim()).toBe("export function LoginButton() {");
        } finally {
            await codebase.dispose();
        }
    });

    it("greps for matches via ripgrep", async () => {
        const codebase = await makeCodebase();
        try {
            const hits = await codebase.grep("Sign In");
            expect(hits).toHaveLength(1);
            expect(hits[0]!.path).toBe("src/login.tsx");
            expect(hits[0]!.line).toBeGreaterThan(0);
            expect(hits[0]!.match).toContain("Sign In");
        } finally {
            await codebase.dispose();
        }
    });

    it("greps respects the glob filter", async () => {
        const codebase = await makeCodebase();
        try {
            const hits = await codebase.grep("export function", { glob: "**/checkout.tsx" });
            expect(hits).toHaveLength(1);
            expect(hits[0]!.path).toBe("src/checkout.tsx");
        } finally {
            await codebase.dispose();
        }
    });

    it("greps caps results at maxResults", async () => {
        const codebase = await makeCodebase();
        try {
            const hits = await codebase.grep("export", { maxResults: 1 });
            expect(hits).toHaveLength(1);
        } finally {
            await codebase.dispose();
        }
    });

    it("returns empty array on no grep matches", async () => {
        const codebase = await makeCodebase();
        try {
            const hits = await codebase.grep("ThisStringDoesNotExistAnywhere");
            expect(hits).toEqual([]);
        } finally {
            await codebase.dispose();
        }
    });

    it("globs files by pattern, excluding default ignores", async () => {
        const codebase = await makeCodebase();
        try {
            const tsxFiles = (await codebase.glob("**/*.tsx")).sort();
            expect(tsxFiles).toEqual(["src/checkout.tsx", "src/login.tsx"]);

            const allFiles = await codebase.glob("**/*");
            expect(allFiles).toContain("README.md");
            expect(allFiles.every((p) => !p.startsWith(".git"))).toBe(true);
        } finally {
            await codebase.dispose();
        }
    });

    it("lists directory entries excluding .git", async () => {
        const codebase = await makeCodebase();
        try {
            const entries = await codebase.listDirectory(".");
            const names = entries.map((e) => e.name).sort();
            expect(names).not.toContain(".git");
            expect(names).toContain("src");
            expect(names).toContain("README.md");

            const srcEntries = await codebase.listDirectory("src");
            expect(srcEntries.map((e) => e.name).sort()).toEqual(["checkout.tsx", "login.tsx"]);
        } finally {
            await codebase.dispose();
        }
    });

    it("follows symlinks that point outside the clone (agent navigation is unrestricted)", async () => {
        const codebase = await makeCodebase();
        try {
            const content = await codebase.readFile("outside-link.txt");
            expect(content.trim()).toBe("value-from-outside");
        } finally {
            await codebase.dispose();
        }
    });

    it("dispose removes the on-disk clone", async () => {
        const codebase = await makeCodebase();
        await codebase.dispose();
        await expect(fs.access(codebase.root)).rejects.toThrow();
    });

    it("supports reuse: multiple operations on the same instance", async () => {
        const codebase = await makeCodebase();
        try {
            await codebase.readFile("README.md");
            await codebase.grep("Sign In");
            await codebase.listDirectory("src");
        } finally {
            await codebase.dispose();
        }
    });
});
