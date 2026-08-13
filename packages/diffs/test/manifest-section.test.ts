import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { buildRepoManifestSection } from "../src/codebase";
import type { RepoCheckout, RepoManifest } from "../src/codebase";

const execFileAsync = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
});

async function git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
        cwd,
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "T",
            GIT_AUTHOR_EMAIL: "t@example.test",
            GIT_COMMITTER_NAME: "T",
            GIT_COMMITTER_EMAIL: "t@example.test",
        },
    });
    return stdout.trim();
}

/** A real git repo with a base commit and a head commit that changes `file`; returns dir + both shas. */
async function repoWithChange(file: string, before: string, after: string): Promise<RepoCheckout> {
    const dir = await mkdtemp(join(tmpdir(), "manifest-repo-"));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    await git(dir, ["init", "-q", "-b", "main"]);
    await fs.writeFile(join(dir, file), before);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-q", "-m", "base"]);
    const baseSha = await git(dir, ["rev-parse", "HEAD"]);
    await fs.writeFile(join(dir, file), after);
    await git(dir, ["add", "."]);
    await git(dir, ["commit", "-q", "-m", "change"]);
    const headSha = await git(dir, ["rev-parse", "HEAD"]);
    return { name: "acme/api", role: "dependency", relPath: "acme__api", dir, headSha, baseSha };
}

describe("buildRepoManifestSection", () => {
    it("names each repo, scopes the primary diff to its dir, and inlines a dependency's --stat", async () => {
        const dep = await repoWithChange("pricing.ts", "export const tax = 0.1;\n", "export const tax = 1.0;\n");
        const manifest: RepoManifest = {
            workspaceRoot: "/tmp/ws",
            primary: {
                name: "acme/web",
                role: "primary",
                relPath: "acme__web",
                dir: "/tmp/ws/acme__web",
                headSha: "web-head",
                baseSha: "web-base",
            },
            dependencies: [dep],
            unavailable: [{ name: "acme/gone", reason: "clone failed" }],
        };

        const section = await buildRepoManifestSection(manifest);

        // Primary: named, its diff command scoped to its sibling dir.
        expect(section).toContain("**acme/web** (primary, directory `acme__web`)");
        expect(section).toContain("git -C acme__web diff web-base..web-head");
        // Dependency: named, with its real --stat (the changed file) inlined.
        expect(section).toContain("**acme/api** (dependency, directory `acme__api`)");
        expect(section).toContain("pricing.ts");
        expect(section).toContain(`git -C acme__api diff ${dep.baseSha}..${dep.headSha}`);
        // Unavailable repo named for degrade.
        expect(section).toContain("acme/gone (clone failed)");
    });

    it("marks a dependency with no base sha as read-only", async () => {
        const manifest: RepoManifest = {
            workspaceRoot: "/tmp/ws",
            primary: {
                name: "acme/web",
                role: "primary",
                relPath: "acme__web",
                dir: "/tmp/ws/acme__web",
                headSha: "h",
                baseSha: "b",
            },
            dependencies: [
                {
                    name: "acme/api",
                    role: "dependency",
                    relPath: "acme__api",
                    dir: "/tmp/ws/acme__api",
                    headSha: "api-h",
                },
            ],
            unavailable: [],
        };

        const section = await buildRepoManifestSection(manifest);
        expect(section).toContain("read-only");
        expect(section).not.toContain("diff api-h");
    });
});
