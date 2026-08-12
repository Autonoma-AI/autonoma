import { mkdir, readdir, writeFile } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * clearOutputDir resolves its own path under the real home directory, so the
 * home is redirected at import time rather than passed in - the production
 * signature takes a slug, not a directory, and should stay that way.
 */
const HOME = join(process.cwd(), "node_modules", ".tmp", "clear-output-dir-home");
vi.mock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof NodeOs>();
    return { ...actual, homedir: () => HOME };
});

const SLUG = "acme-web";
const RUN_DIR = join(HOME, ".autonoma", SLUG);

async function seedPreviousRun(): Promise<void> {
    await mkdir(join(RUN_DIR, "qa-tests", "checkout"), { recursive: true });
    await mkdir(join(RUN_DIR, "qa-tests", "_invalid"), { recursive: true });
    for (const [path, body] of [
        [".pipeline-state.json", "{}"],
        [".bfs-state.json", "{}"],
        [".journey-state.json", "{}"],
        ["recipe.json", "{}"],
        ["AUTONOMA.md", "# kb"],
        ["entity-audit.md", "# entities"],
        ["qa-tests/INDEX.md", "# index"],
        ["qa-tests/checkout/pay.md", "# test"],
        ["qa-tests/_invalid/broken.md", "# broken"],
    ] as const) {
        await writeFile(join(RUN_DIR, path), body, "utf-8");
    }
}

beforeEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(join(HOME, ".autonoma"), { recursive: true, force: true });
});

afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(HOME, { recursive: true, force: true });
});

describe("starting a run over", () => {
    test("leaves nothing of the previous run behind", async () => {
        const { clearOutputDir } = await import("../../src/core/output");
        await seedPreviousRun();

        await clearOutputDir(SLUG);

        // Deliberately asserted as "empty", not as a list of files removed: the
        // bug was a hand-maintained cleanup list that missed whatever was added
        // next, and a per-file assertion would reproduce that flaw in the test.
        expect(await readdir(RUN_DIR)).toEqual([]);
    });

    test("leaves a usable directory, not a missing one", async () => {
        const { clearOutputDir } = await import("../../src/core/output");
        await seedPreviousRun();

        await clearOutputDir(SLUG);
        await writeFile(join(RUN_DIR, "AUTONOMA.md"), "# fresh", "utf-8");

        expect(await readdir(RUN_DIR)).toEqual(["AUTONOMA.md"]);
    });

    test("is a no-op on a slug that has never run", async () => {
        const { clearOutputDir } = await import("../../src/core/output");
        await expect(clearOutputDir("never-seen")).resolves.toBeUndefined();
        expect(await readdir(join(HOME, ".autonoma", "never-seen"))).toEqual([]);
    });

    test("does not touch anything outside the app's own directory", async () => {
        const { clearOutputDir } = await import("../../src/core/output");
        await seedPreviousRun();
        // Credentials and the analytics id live at the AUTONOMA_HOME root.
        await writeFile(join(HOME, ".autonoma", ".env"), "TOKEN=keep", "utf-8");
        await mkdir(join(HOME, ".autonoma", "other-app"), { recursive: true });
        await writeFile(join(HOME, ".autonoma", "other-app", "recipe.json"), "{}", "utf-8");

        await clearOutputDir(SLUG);

        expect((await readdir(join(HOME, ".autonoma"))).sort()).toEqual([".env", SLUG, "other-app"].sort());
        expect(await readdir(join(HOME, ".autonoma", "other-app"))).toEqual(["recipe.json"]);
    });
});
