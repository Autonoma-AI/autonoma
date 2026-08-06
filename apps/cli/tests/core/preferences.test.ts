import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

let home: string;

// The module resolves its path at import time from AUTONOMA_HOME, so the temporary
// home has to exist before it loads - hence the dynamic import in each test.
async function loadPreferences() {
    vi.resetModules();
    vi.doMock("../../src/core/output", () => ({ AUTONOMA_HOME: home }));
    return import("../../src/core/preferences");
}

beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "autonoma-prefs-"));
});

afterEach(async () => {
    vi.doUnmock("../../src/core/output");
    await rm(home, { recursive: true, force: true });
});

describe("preferences", () => {
    test("reads nothing on a first run rather than failing", async () => {
        const { readPreferences } = await loadPreferences();

        expect(await readPreferences()).toEqual({});
    });

    test("keeps a choice across runs", async () => {
        const { readPreferences, updatePreferences } = await loadPreferences();

        await updatePreferences({ agentId: "codex" });

        expect(await readPreferences()).toEqual({ agentId: "codex" });
    });

    // The file is on the user's disk and written by whatever version they last ran, so
    // a shape that has since changed must read as "no preference" rather than reach a
    // caller - and must not end the run either.
    test("ignores a file it cannot make sense of", async () => {
        const { readPreferences } = await loadPreferences();
        await writeFile(join(home, "preferences.json"), "{ not json", "utf-8");

        expect(await readPreferences()).toEqual({});
    });

    test("merges rather than replacing, so one write cannot drop another field", async () => {
        const { updatePreferences } = await loadPreferences();

        await updatePreferences({ agentId: "claude" });
        await updatePreferences({});

        const raw = JSON.parse(await readFile(join(home, "preferences.json"), "utf-8"));
        expect(raw).toEqual({ agentId: "claude" });
    });
});
