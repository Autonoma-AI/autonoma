import { mkdtempSync } from "node:fs";
import { chmod, readdir, rm } from "node:fs/promises";
import type * as NodeOs from "node:os";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";

// `ensureOutputDir` resolves ~/.autonoma at module load, so the fake home has to
// exist before the import below - hence the sync mkdtemp.
const fakeHome = mkdtempSync(join(tmpdir(), "autonoma-home-"));

vi.mock("node:os", async (importOriginal) => {
    const actual = await importOriginal<typeof NodeOs>();
    return { ...actual, homedir: () => fakeHome };
});

const { ensureOutputDir } = await import("../../src/core/output");

afterAll(async () => {
    await chmod(join(fakeHome, ".autonoma", "locked"), 0o700).catch(() => undefined);
    await rm(fakeHome, { recursive: true, force: true });
});

describe("ensureOutputDir writability check", () => {
    test("returns the directory and leaves no probe behind", async () => {
        const dir = await ensureOutputDir("writable");

        expect(dir).toBe(join(fakeHome, ".autonoma", "writable"));
        await expect(readdir(dir)).resolves.toEqual([]);
    });

    test("is idempotent across resumes", async () => {
        await expect(ensureOutputDir("writable")).resolves.toBe(join(fakeHome, ".autonoma", "writable"));
        await expect(readdir(join(fakeHome, ".autonoma", "writable"))).resolves.toEqual([]);
    });

    test("fails with an actionable message when the directory rejects writes", async () => {
        // Create it first, then drop write permission, so mkdir succeeds and the
        // probe write is what fails - the shape of a quota or read-only mount.
        const dir = await ensureOutputDir("locked");
        await chmod(dir, 0o500);

        await expect(ensureOutputDir("locked")).rejects.toThrow(
            /Cannot write to ~\/\.autonoma\/locked[\s\S]*permissions/,
        );

        await chmod(dir, 0o700);
    });
});
