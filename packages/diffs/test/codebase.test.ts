import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type CloneRepositoryParams, FakeGitHubInstallationClient } from "@autonoma/github";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Codebase } from "../src/codebase";
import type { RepoCheckout } from "../src/codebase";

const execFileAsync = promisify(execFile);

let fixtureDir: string;

beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), "codebase-fixture-"));
    await fs.mkdir(join(fixtureDir, "src"));
    await fs.writeFile(join(fixtureDir, "README.md"), "# Test fixture\n");
});

afterAll(async () => {
    if (fixtureDir != null) await fs.rm(fixtureDir, { recursive: true, force: true });
});

async function makeCodebase(): Promise<Codebase> {
    const targetDir = await mkdtemp(join(tmpdir(), "codebase-target-"));
    await fs.cp(fixtureDir, targetDir, { recursive: true });
    return new Codebase(targetDir);
}

describe("Codebase", () => {
    it("exposes the on-disk root the bash tool runs against", async () => {
        const codebase = await makeCodebase();
        try {
            const readme = await fs.readFile(join(codebase.root, "README.md"), "utf-8");
            expect(readme).toContain("Test fixture");
        } finally {
            await codebase.dispose();
        }
    });

    it("dispose removes the on-disk clone", async () => {
        const codebase = await makeCodebase();
        await codebase.dispose();
        await expect(fs.access(codebase.root)).rejects.toThrow();
    });

    it("clone clears a dangling target tree before cloning", async () => {
        const targetDir = await mkdtemp(join(tmpdir(), "codebase-dangling-"));
        const danglingFile = join(targetDir, "stale-from-previous-run.txt");
        await fs.writeFile(danglingFile, "leftover\n");

        const client = new ClearTrackingGitHubClient(danglingFile);
        const codebase = await Codebase.clone(client, targetDir, { repoName: "owner/repo", commitSha: "abc123" });

        try {
            // The fake records whether the dangling file survived into the clone
            // call - it must not, because clone() rimrafs the target first.
            expect(client.danglingFileSurvived).toBe(false);
            const readme = await fs.readFile(join(codebase.root, "README.md"), "utf-8");
            expect(readme).toContain("cloned fixture");
        } finally {
            await codebase.dispose();
        }
    });
});

describe("Codebase.cloneWorkspace", () => {
    it("lays out the primary and dependencies as sibling directories with a manifest", async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), "codebase-ws-"));
        const client = new MaterializingGitHubClient();

        const codebase = await Codebase.cloneWorkspace(client, workspaceDir, {
            primary: { name: "acme/web", commitSha: "web-head", baseSha: "web-base" },
            dependencies: [
                { name: "acme/api", commitSha: "api-head", baseSha: "api-base" },
                { name: "acme/worker", commitSha: "worker-head" },
            ],
        });

        try {
            expect(codebase.root).toBe(workspaceDir);
            // Primary lives at its named sibling (owner/repo -> owner__repo), not at the workspace root.
            expect(codebase.primary.relPath).toBe("acme__web");
            expect(codebase.primaryDir).toBe(join(workspaceDir, "acme__web"));
            await expect(fs.readFile(join(workspaceDir, "acme__web", "CLONED"), "utf-8")).resolves.toContain(
                "acme/web",
            );
            await expect(fs.readFile(join(workspaceDir, "acme__api", "CLONED"), "utf-8")).resolves.toContain(
                "acme/api",
            );

            const manifest = codebase.dependencyManifest();
            expect(manifest?.dependencies).toEqual([
                {
                    name: "acme/api",
                    role: "dependency",
                    relPath: "acme__api",
                    dir: join(workspaceDir, "acme__api"),
                    headSha: "api-head",
                    baseSha: "api-base",
                },
                {
                    name: "acme/worker",
                    role: "dependency",
                    relPath: "acme__worker",
                    dir: join(workspaceDir, "acme__worker"),
                    headSha: "worker-head",
                    baseSha: undefined,
                },
            ]);
        } finally {
            await codebase.dispose();
        }
    });

    it("degrades a failed dependency clone to unavailable without aborting the workspace", async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), "codebase-ws-fail-"));
        const client = new MaterializingGitHubClient(new Set(["acme/api"]));

        const codebase = await Codebase.cloneWorkspace(client, workspaceDir, {
            primary: { name: "acme/web", commitSha: "web-head" },
            dependencies: [{ name: "acme/api", commitSha: "api-head", baseSha: "api-base" }],
        });

        try {
            expect(codebase.repos.map((r) => r.name)).toEqual(["acme/web"]);
            const manifest = codebase.dependencyManifest();
            expect(manifest?.dependencies).toEqual([]);
            expect(manifest?.unavailable).toEqual([{ name: "acme/api", reason: "clone failed" }]);
        } finally {
            await codebase.dispose();
        }
    });

    it("throws and cleans up when the primary clone fails", async () => {
        const workspaceDir = await mkdtemp(join(tmpdir(), "codebase-ws-primary-"));
        const client = new MaterializingGitHubClient(new Set(["acme/web"]));

        await expect(
            Codebase.cloneWorkspace(client, workspaceDir, {
                primary: { name: "acme/web", commitSha: "web-head" },
                dependencies: [],
            }),
        ).rejects.toThrow();
        await expect(fs.access(workspaceDir)).rejects.toThrow();
    });
});

describe("new Codebase(root) is a flat single-repo checkout", () => {
    it("has no dependency manifest and its primaryDir is the root", () => {
        const codebase = new Codebase("/tmp/single");
        expect(codebase.dependencyManifest()).toBeUndefined();
        expect(codebase.primaryDir).toBe("/tmp/single");
    });
});

// The invariant the merge-flow boundary (impact-analysis.ts) violated by passing `codebase.root`: in a multi-repo
// workspace `root` is the parent that holds the repos, NOT a git repo - so any git-boundary consumer must use
// `primaryDir`. This proves the two diverge and that git resolves at primaryDir but not root.
describe("a multi-repo workspace's root is not a git repo", () => {
    it("resolves git at primaryDir (the primary clone) but not at root (the parent)", async () => {
        const root = await mkdtemp(join(tmpdir(), "codebase-gitroot-"));
        const primaryDir = join(root, "acme__web");
        await fs.mkdir(primaryDir, { recursive: true });
        await execFileAsync("git", ["init", "-q"], { cwd: primaryDir });

        const primary: RepoCheckout = {
            name: "acme/web",
            role: "primary",
            relPath: "acme__web",
            dir: primaryDir,
            headSha: "web-head",
            baseSha: "web-base",
        };
        const codebase = new Codebase(root, [primary], []);

        try {
            expect(codebase.root).toBe(root);
            expect(codebase.primaryDir).toBe(primaryDir);
            expect(codebase.primaryDir).not.toBe(codebase.root);

            // git works against the primary clone...
            await expect(
                execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: codebase.primaryDir }),
            ).resolves.toBeDefined();
            // ...but the workspace root is not a repository, which is exactly why the merge flow must not run there.
            await expect(execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: codebase.root })).rejects.toThrow();
        } finally {
            await fs.rm(root, { recursive: true, force: true });
        }
    });
});

/**
 * Fake client whose `cloneRepository` writes a `CLONED` marker (naming the repo) into each target dir, and throws
 * for any repo in `failFor` so tests can drive the degrade path.
 */
class MaterializingGitHubClient extends FakeGitHubInstallationClient {
    constructor(private readonly failFor: Set<string> = new Set()) {
        super();
    }

    override async cloneRepository(params: CloneRepositoryParams): Promise<string> {
        if (this.failFor.has(params.fullName)) throw new Error(`Simulated clone failure for ${params.fullName}`);
        await fs.mkdir(params.targetDir, { recursive: true });
        await fs.writeFile(join(params.targetDir, "CLONED"), `cloned ${params.fullName}\n`);
        return params.targetDir;
    }
}

/**
 * Fake client whose `cloneRepository` records whether a known dangling file
 * still existed at clone time (it should not - `Codebase.clone` clears the
 * target first), then populates the target dir with a minimal fixture.
 */
class ClearTrackingGitHubClient extends FakeGitHubInstallationClient {
    public danglingFileSurvived = true;

    constructor(private readonly danglingFile: string) {
        super();
    }

    override async cloneRepository(params: CloneRepositoryParams): Promise<string> {
        this.danglingFileSurvived = await fs
            .access(this.danglingFile)
            .then(() => true)
            .catch(() => false);

        await fs.mkdir(params.targetDir, { recursive: true });
        await fs.writeFile(join(params.targetDir, "README.md"), "# cloned fixture\n");
        return params.targetDir;
    }
}
