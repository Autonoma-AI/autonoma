import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveTurboFilter } from "../../src/dockerfile-builder/turbo-filter";

/**
 * Fixture app dir materialized to a tmpdir per test. Files are declared inline
 * so they never show up in editor/fuzzy file search the way an on-disk
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
                console.warn(`[turbo-filter.test] failed to clean up fixture dir ${p}:`, err);
            }),
        ),
    );
});

async function tmpFixture(fixture: Fixture): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "previewkit-turbo-filter-fixture-"));
    cleanupPaths.push(root);
    for (const [relPath, contents] of Object.entries(fixture)) {
        const full = join(root, relPath);
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, contents, "utf8");
    }
    return root;
}

describe("resolveTurboFilter", () => {
    it("uses the package.json name field when present (even when it differs from the dir name)", async () => {
        const root = await tmpFixture({
            "apps/web/package.json": JSON.stringify({ name: "@scope/storefront" }),
        });
        expect(resolveTurboFilter(join(root, "apps/web"), "apps/web")).toBe("--filter=@scope/storefront");
    });

    it("falls back to a path-based filter when the name field is missing", async () => {
        const root = await tmpFixture({
            "apps/web/package.json": JSON.stringify({ version: "1.0.0" }),
        });
        expect(resolveTurboFilter(join(root, "apps/web"), "apps/web")).toBe("--filter=./apps/web");
    });

    it("falls back to a path-based filter when package.json is unreadable JSON", async () => {
        const root = await tmpFixture({
            "apps/web/package.json": "{ this is not json",
        });
        expect(resolveTurboFilter(join(root, "apps/web"), "apps/web")).toBe("--filter=./apps/web");
    });

    it("falls back to a path-based filter when package.json is absent", async () => {
        const root = await tmpFixture({});
        expect(resolveTurboFilter(join(root, "apps/web"), "apps/web")).toBe("--filter=./apps/web");
    });
});
