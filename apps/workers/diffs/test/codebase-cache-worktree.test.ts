import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type CheckoutHandle, ensureCachedCheckout } from "../evals/framework/codebase-cache";

/**
 * The parallelization guarantee, exercised end to end over real git: many cases checking out the
 * same repo at once - some at different SHAs, some at the same SHA - each land in their own worktree
 * with the right files, and disposing removes it. Per-case isolation to its own working tree is what
 * makes running the suites with `test.concurrent` safe.
 *
 * Hermetic: a source repo is built locally and pre-cloned into the cache, so both frozen SHAs are
 * already present and `ensureCachedCheckout` never touches the network or the GitHub App.
 */

const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: "eval-test",
    GIT_AUTHOR_EMAIL: "eval-test@example.com",
    GIT_COMMITTER_NAME: "eval-test",
    GIT_COMMITTER_EMAIL: "eval-test@example.com",
};

function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf-8" }).trim();
}

describe("ensureCachedCheckout worktrees", () => {
    let workDir: string;
    let cacheRoot: string;
    let repoDir: string;
    let shaA: string;
    let shaB: string;

    const owner = "acme";
    const repo = "widgets";

    beforeAll(() => {
        workDir = mkdtempSync(join(tmpdir(), "codebase-cache-test-"));

        // A source repo with two commits that differ in one file, so a worktree's checked-out SHA is
        // observable from its file contents.
        const source = join(workDir, "source");
        mkdirSync(source);
        git(source, ["init", "-q"]);
        writeFileSync(join(source, "marker.txt"), "A");
        git(source, ["add", "."]);
        git(source, ["commit", "-q", "-m", "A"]);
        shaA = git(source, ["rev-parse", "HEAD"]);
        writeFileSync(join(source, "marker.txt"), "B");
        git(source, ["commit", "-q", "-am", "B"]);
        shaB = git(source, ["rev-parse", "HEAD"]);

        // Pre-seed the cache with a clone, so ensureBaseClone reuses it and neither SHA needs fetching.
        cacheRoot = join(workDir, "cache");
        mkdirSync(cacheRoot);
        repoDir = join(cacheRoot, `${owner}__${repo}`);
        git(cacheRoot, ["clone", "-q", source, repoDir]);
    });

    afterAll(() => {
        rmSync(workDir, { recursive: true, force: true });
    });

    it("gives every concurrent case its own worktree at its own SHA", async () => {
        const coords = (headSha: string) => ({ owner, repo, installationId: 1, baseSha: shaA, headSha });

        // Three cases against one repo, at once: two distinct SHAs plus a duplicate of the first -
        // the real corpus shape, where one repo dominates and several cases share a SHA pair.
        const [caseA, caseB, caseADup]: CheckoutHandle[] = await Promise.all([
            ensureCachedCheckout(coords(shaA), { cacheRoot, label: "case-a" }),
            ensureCachedCheckout(coords(shaB), { cacheRoot, label: "case-b" }),
            ensureCachedCheckout(coords(shaA), { cacheRoot, label: "case-a-dup" }),
        ]);
        if (caseA == null || caseB == null || caseADup == null) throw new Error("expected three checkouts");

        const roots = [caseA.codebase.root, caseB.codebase.root, caseADup.codebase.root];

        // Every case got a distinct worktree under the repo's worktrees dir.
        expect(new Set(roots).size).toBe(3);
        for (const root of roots) {
            expect(root.startsWith(`${repoDir}.worktrees`)).toBe(true);
        }

        // Each worktree holds the file at its own head SHA - no cross-contamination.
        expect(readFileSync(join(caseA.codebase.root, "marker.txt"), "utf-8")).toBe("A");
        expect(readFileSync(join(caseB.codebase.root, "marker.txt"), "utf-8")).toBe("B");
        expect(readFileSync(join(caseADup.codebase.root, "marker.txt"), "utf-8")).toBe("A");

        // Disposing removes each worktree from disk.
        await Promise.all([caseA, caseB, caseADup].map((h) => h.dispose()));
        for (const root of roots) {
            expect(existsSync(root)).toBe(false);
        }
    });
});
