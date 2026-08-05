import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectBlueprintFacts } from "../../src/dockerfile-builder/detect-blueprint-facts";

/**
 * Fixture repo materialized to a tmpdir per test. Files are declared inline so
 * they never show up in editor/fuzzy file search the way an on-disk
 * test/fixtures/ tree would.
 */
type Fixture = Record<string, string>;

let cleanupPaths: string[] = [];

beforeEach(() => {
    cleanupPaths = [];
});

afterEach(async () => {
    await Promise.all(
        cleanupPaths.map((p) =>
            rm(p, { recursive: true, force: true }).catch((err: unknown) => {
                console.warn(`[detect-blueprint-facts.test] failed to clean up fixture dir ${p}:`, err);
            }),
        ),
    );
});

async function tmpRepo(fixture: Fixture): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "previewkit-blueprint-facts-fixture-"));
    cleanupPaths.push(root);
    for (const [relPath, contents] of Object.entries(fixture)) {
        const full = join(root, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, contents, "utf8");
    }
    return root;
}

describe("detectBlueprintFacts", () => {
    it("detects pnpm from the root lockfile in a root build", async () => {
        const repo = await tmpRepo({
            "pnpm-lock.yaml": "",
            "apps/web/package.json": JSON.stringify({ name: "@acme/web" }),
        });
        const facts = detectBlueprintFacts({ preset: "nextjs", build_context: "root" }, repo, "apps/web");
        expect(facts).toEqual({ packageManager: "pnpm", hasLockfile: true, appPath: "apps/web" });
    });

    it("resolves a turbo filter for a node preset root build of a turbo repo", async () => {
        const repo = await tmpRepo({
            "pnpm-lock.yaml": "",
            "turbo.json": "{}",
            "apps/web/package.json": JSON.stringify({ name: "@acme/web" }),
        });
        const facts = detectBlueprintFacts({ preset: "nextjs", build_context: "root" }, repo, "apps/web");
        expect(facts.turboFilter).toBe("--filter=@acme/web");
    });

    it("skips the turbo filter for a non-node preset root build", async () => {
        const repo = await tmpRepo({ "turbo.json": "{}", "apps/api/pyproject.toml": "" });
        const facts = detectBlueprintFacts({ preset: "django", build_context: "root" }, repo, "apps/api");
        expect(facts.turboFilter).toBeUndefined();
    });

    it("lets the packageManager field win over the lockfile", async () => {
        const repo = await tmpRepo({
            "package-lock.json": "{}",
            "package.json": JSON.stringify({ packageManager: "pnpm@9.1.0" }),
        });
        const facts = detectBlueprintFacts({ preset: "node", build_context: "root" }, repo, ".");
        // The pinned manager wins, but its own lockfile is absent - tolerant install.
        expect(facts).toEqual({ packageManager: "pnpm", hasLockfile: false, appPath: "." });
    });

    it("sniffs the app dir (not the repo root) for an app-context build", async () => {
        const repo = await tmpRepo({
            "pnpm-lock.yaml": "",
            "apps/web/yarn.lock": "",
            "apps/web/package.json": JSON.stringify({ name: "web" }),
        });
        const facts = detectBlueprintFacts({ preset: "node" }, repo, "apps/web");
        expect(facts).toEqual({ packageManager: "yarn", hasLockfile: true, appPath: "." });
    });

    it("defaults to npm without a lockfile", async () => {
        const repo = await tmpRepo({ "package.json": "{}" });
        const facts = detectBlueprintFacts({ preset: "express" }, repo, ".");
        expect(facts).toEqual({ packageManager: "npm", hasLockfile: false, appPath: "." });
    });

    it("falls back to npm for a bun lockfile (bun is not on the node runtime image)", async () => {
        const repo = await tmpRepo({ "bun.lock": "" });
        const facts = detectBlueprintFacts({ preset: "node" }, repo, ".");
        expect(facts).toEqual({ packageManager: "npm", hasLockfile: false, appPath: "." });
    });

    it("fails loud on competing lockfiles (stale leftover from a tooling switch)", async () => {
        const repo = await tmpRepo({ "pnpm-lock.yaml": "", "yarn.lock": "" });
        expect(() => detectBlueprintFacts({ preset: "node" }, repo, ".")).toThrow(/competing lockfiles.*pnpm, yarn/);
    });

    it("detects facts for a dockerfile blueprint too (no turbo filter)", async () => {
        const repo = await tmpRepo({ "pnpm-lock.yaml": "", "turbo.json": "{}", "apps/web/Dockerfile": "FROM x" });
        const facts = detectBlueprintFacts({ dockerfile: "./Dockerfile", build_context: "root" }, repo, "apps/web");
        expect(facts).toEqual({ packageManager: "pnpm", hasLockfile: true, appPath: "apps/web" });
    });

    it("rejects an app path the generated Dockerfile cannot carry safely", async () => {
        const repo = await tmpRepo({ "package.json": "{}" });
        expect(() => detectBlueprintFacts({ preset: "node", build_context: "root" }, repo, "apps/we b")).toThrow(
            /cannot carry safely/,
        );
    });
});
