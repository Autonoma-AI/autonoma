import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Build } from "../../src/config/schema";
import { resolveBuildTurboFilter } from "../../src/dockerfile-builder/resolve-build-turbo-filter";

/**
 * Monorepo fixture materialized to a tmpdir per test. Declared inline so a
 * fixture package.json never shows up in editor/fuzzy file search.
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
                console.warn(`[resolve-build-turbo-filter.test] failed to clean up fixture dir ${p}:`, err);
            }),
        ),
    );
});

async function tmpRepo(fixture: Fixture): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "previewkit-build-filter-fixture-"));
    cleanupPaths.push(root);
    for (const [relPath, contents] of Object.entries(fixture)) {
        const full = join(root, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, contents, "utf8");
    }
    return root;
}

const rootNextBuild: Build = {
    framework: "next",
    package_manager: "pnpm",
    node_version: "22",
    build_context: "root",
};

describe("resolveBuildTurboFilter", () => {
    it("filters a root build by the app's real workspace package name, not its k8s app name", async () => {
        // The config app.name is "web" (k8s), but the workspace package is
        // "@acme/storefront" - the exact mismatch that broke the legacy path.
        const repoDir = await tmpRepo({
            "apps/web/package.json": JSON.stringify({ name: "@acme/storefront" }),
        });
        expect(resolveBuildTurboFilter(rootNextBuild, repoDir, "apps/web")).toBe("--filter=@acme/storefront");
    });

    it("falls back to a path-based filter for a root build when package.json has no name", async () => {
        const repoDir = await tmpRepo({
            "apps/web/package.json": JSON.stringify({ version: "1.0.0" }),
        });
        expect(resolveBuildTurboFilter(rootNextBuild, repoDir, "apps/web")).toBe("--filter=./apps/web");
    });

    it("falls back to a path-based filter for a root build when package.json is absent", async () => {
        const repoDir = await tmpRepo({});
        expect(resolveBuildTurboFilter(rootNextBuild, repoDir, "apps/web")).toBe("--filter=./apps/web");
    });

    it("returns undefined for an app-context build (no monorepo filter)", async () => {
        const repoDir = await tmpRepo({
            "apps/web/package.json": JSON.stringify({ name: "@acme/storefront" }),
        });
        const appBuild: Build = {
            framework: "next",
            package_manager: "pnpm",
            node_version: "22",
            build_context: "app",
        };
        expect(resolveBuildTurboFilter(appBuild, repoDir, "apps/web")).toBeUndefined();
    });

    it("returns undefined for a runtime build even when its context is root", async () => {
        const repoDir = await tmpRepo({
            "apps/web/package.json": JSON.stringify({ name: "@acme/storefront" }),
        });
        const runtimeBuild: Build = {
            framework: "runtime",
            runtime: "node",
            entrypoint: "npm start",
            build_context: "root",
        };
        expect(resolveBuildTurboFilter(runtimeBuild, repoDir, "apps/web")).toBeUndefined();
    });
});
