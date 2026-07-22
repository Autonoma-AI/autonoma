import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { findUncoveredDirs } from "../../src/agents/00-project-mapper/coverage";
import type { ProjectMap } from "../../src/core/project-map";

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "map-coverage-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

async function seed(paths: string[]): Promise<void> {
    for (const p of paths) await mkdir(join(root, p), { recursive: true });
}

function mapOf(frontends: string[], backends: string[], ignore: string[] = []): ProjectMap {
    return {
        frontends: frontends.map((path) => ({ path, framework: "unknown", dependsOn: [], why: "w" })),
        backends: backends.map((path) => ({ path, language: "ts", framework: "unknown", why: "w" })),
        ignore: ignore.map((path) => ({ path, why: "w" })),
    };
}

describe("findUncoveredDirs", () => {
    test("reports exactly the workspace member the map missed", async () => {
        await seed(["apps/web", "apps/db-api", "apps/temporal-worker", "packages/api", "packages/db"]);
        const map = mapOf(["apps/web"], ["apps/db-api", "packages/api", "packages/db"]);
        expect(await findUncoveredDirs(root, map)).toEqual(["apps/temporal-worker"]);
    });

    test("a fully covered repo reports nothing", async () => {
        await seed(["apps/web", "packages/db", "docs"]);
        const map = mapOf(["apps/web"], ["packages/db"], ["docs"]);
        expect(await findUncoveredDirs(root, map)).toEqual([]);
    });

    test("unclassified top-level directories are reported", async () => {
        await seed(["apps/web", "scripts"]);
        const map = mapOf(["apps/web"], []);
        expect(await findUncoveredDirs(root, map)).toEqual(["scripts"]);
    });

    test("dot-dirs and dependency/build artifacts never count", async () => {
        await seed(["apps/web", ".github/workflows", "node_modules/react", "dist"]);
        const map = mapOf(["apps/web"], []);
        expect(await findUncoveredDirs(root, map)).toEqual([]);
    });

    test("an ancestor entry covers everything beneath it", async () => {
        await seed(["apps/web/src/components", "apps/api"]);
        const map = mapOf(["apps/web"], ["apps/api"]);
        expect(await findUncoveredDirs(root, map)).toEqual([]);
    });

    test("a repo-root entry (single fullstack app) covers the whole tree", async () => {
        await seed(["src", "prisma", "public"]);
        const map = mapOf(["."], ["."]);
        expect(await findUncoveredDirs(root, map)).toEqual([]);
    });

    test("files at the top level are not directories and never count", async () => {
        await seed(["apps/web"]);
        await writeFile(join(root, "README.md"), "hi", "utf-8");
        const map = mapOf(["apps/web"], []);
        expect(await findUncoveredDirs(root, map)).toEqual([]);
    });
});
