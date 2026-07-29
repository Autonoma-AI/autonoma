import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { isTestFile, listTestFiles, normalizeTestFilename, TEST_INDEX_FILE } from "../../src/core/test-files";

describe("the generated-test file contract", () => {
    test("a filename the model forgot to extend still lands as markdown", () => {
        // The whole pipeline finds tests by extension; a bare name would exist
        // on disk while never being uploaded, reviewed, or counted.
        expect(normalizeTestFilename("login-valid-credentials")).toBe("login-valid-credentials.md");
    });

    test("near-miss extensions are corrected rather than doubled up", () => {
        expect(normalizeTestFilename("login.markdown")).toBe("login.md");
        expect(normalizeTestFilename("login.mdx")).toBe("login.md");
        expect(normalizeTestFilename("  login.md  ")).toBe("login.md");
    });

    test("a name that is already right is left alone, dots and all", () => {
        expect(normalizeTestFilename("v1.2-checkout.md")).toBe("v1.2-checkout.md");
    });

    test("the index is not a test, wherever it sits", () => {
        expect(isTestFile(TEST_INDEX_FILE)).toBe(false);
        expect(isTestFile("qa-tests/INDEX.md")).toBe(false);
        expect(isTestFile("qa-tests/account/edit-profile.md")).toBe(true);
    });

    test("non-markdown files are not tests", () => {
        expect(isTestFile("qa-tests/.bfs-state.json")).toBe(false);
        expect(isTestFile("qa-tests/notes.txt")).toBe(false);
    });
});

describe("listTestFiles", () => {
    let outputDir: string;

    async function write(relPath: string) {
        const abs = join(outputDir, "qa-tests", relPath);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, "# test", "utf-8");
    }

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "list-tests-"));
    });

    afterEach(async () => {
        await rm(outputDir, { recursive: true, force: true });
    });

    test("returns output-dir-relative paths, sorted, at any depth", async () => {
        await write("teams/members/add-member.md");
        await write("admin/create-user.md");
        await write("top-level.md");

        await expect(listTestFiles(outputDir)).resolves.toEqual([
            "qa-tests/admin/create-user.md",
            "qa-tests/teams/members/add-member.md",
            "qa-tests/top-level.md",
        ]);
    });

    test("excludes the index and quarantined tests at any depth", async () => {
        await write("admin/create-user.md");
        await write("INDEX.md");
        await write("_invalid/broken.md");
        await write("_invalid/nested/also-broken.md");

        await expect(listTestFiles(outputDir)).resolves.toEqual(["qa-tests/admin/create-user.md"]);
    });

    test("keeps a test whose own name merely begins like the quarantine directory", async () => {
        await write("admin/_invalid-input-handling.md");

        await expect(listTestFiles(outputDir)).resolves.toEqual(["qa-tests/admin/_invalid-input-handling.md"]);
    });

    test("returns nothing when the suite directory does not exist", async () => {
        await expect(listTestFiles(outputDir)).resolves.toEqual([]);
    });
});
