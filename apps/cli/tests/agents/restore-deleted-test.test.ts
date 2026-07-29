import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { restoreDeletedTest } from "../../src/agents/05-test-generator/restore-deleted-test";

const ORIGINAL = `---
title: "Remove a team member"
---

**Steps**
1. click: Members
`;

describe("restoreDeletedTest", () => {
    let outputDir: string;
    let testPath: string;

    beforeEach(async () => {
        outputDir = await mkdtemp(join(tmpdir(), "restore-test-"));
        testPath = join(outputDir, "qa-tests", "teams", "remove-team-member.md");
        await mkdir(join(outputDir, "qa-tests", "teams"), { recursive: true });
        await writeFile(testPath, ORIGINAL, "utf-8");
    });

    afterEach(async () => {
        await rm(outputDir, { recursive: true });
    });

    test("restores the original when the fix pass never rewrote the test", async () => {
        // What the review cycle does before handing the test to a fix agent.
        await unlink(testPath);

        // The fix agent times out and writes nothing.
        await expect(restoreDeletedTest(testPath, ORIGINAL)).resolves.toBe(true);
        await expect(readFile(testPath, "utf-8")).resolves.toBe(ORIGINAL);
    });

    test("leaves a rewritten test alone", async () => {
        await unlink(testPath);
        const rewritten = ORIGINAL.replace("click: Members", "click: Team members");
        await writeFile(testPath, rewritten, "utf-8");

        await expect(restoreDeletedTest(testPath, ORIGINAL)).resolves.toBe(false);
        await expect(readFile(testPath, "utf-8")).resolves.toBe(rewritten);
    });

    test("reports failure instead of throwing when the restore cannot be written", async () => {
        await unlink(testPath);
        // Block the parent: mkdir hits ENOTDIR, the shape of a real ENOSPC or
        // permission failure. Throwing here would abort the whole review cycle
        // and strand every other test it had deleted.
        await rm(join(outputDir, "qa-tests", "teams"), { recursive: true });
        await writeFile(join(outputDir, "qa-tests", "teams"), "not a directory", "utf-8");

        await expect(restoreDeletedTest(testPath, ORIGINAL)).resolves.toBe(false);
    });

    test("recreates the folder when the cleanup pass removed it", async () => {
        await rm(join(outputDir, "qa-tests", "teams"), { recursive: true });

        await expect(restoreDeletedTest(testPath, ORIGINAL)).resolves.toBe(true);
        await expect(readFile(testPath, "utf-8")).resolves.toBe(ORIGINAL);
    });
});
