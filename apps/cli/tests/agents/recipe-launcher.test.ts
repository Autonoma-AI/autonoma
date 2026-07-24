import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const CANCEL = Symbol("cancel");
const selectMock = vi.fn();

vi.mock("../../src/ui/prompts", () => ({
    select: (...args: unknown[]) => selectMock(...args),
    isCancel: (v: unknown) => v === CANCEL,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMPLETION_MARKER_FILE } from "../../src/agents/04-recipe-builder/completion";
import type { AgentLauncher, PermissionMode } from "../../src/agents/04-recipe-builder/launcher";
import {
    buildAllLaunchers,
    CodexLauncher,
    parsePermissionMode,
    selectLauncher,
    selectPermissionMode,
    watchForCompletion,
} from "../../src/agents/04-recipe-builder/launcher";

function fakeLauncher(id: string, available: boolean): AgentLauncher {
    return {
        id,
        label: `Agent ${id}`,
        isAvailable: () => Promise.resolve(available),
        launch: () => Promise.resolve(0),
    };
}

beforeEach(() => {
    selectMock.mockReset();
});
afterEach(() => {
    vi.restoreAllMocks();
});

describe("parsePermissionMode", () => {
    test.each(["default", "acceptEdits", "bypassPermissions"] as const)("accepts %s", (mode) => {
        expect(parsePermissionMode(mode)).toBe(mode);
    });

    test("rejects unknown or absent values", () => {
        expect(parsePermissionMode("plan")).toBeUndefined();
        expect(parsePermissionMode("YOLO")).toBeUndefined();
        expect(parsePermissionMode(undefined)).toBeUndefined();
    });
});

describe("selectLauncher", () => {
    test("no available agents -> undefined (manual fallback)", async () => {
        const chosen = await selectLauncher([fakeLauncher("claude", false)]);
        expect(chosen).toBeUndefined();
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("exactly one available -> uses it without prompting", async () => {
        const only = fakeLauncher("claude", true);
        const chosen = await selectLauncher([only]);
        expect(chosen).toBe(only);
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("multiple available -> prompts to pick", async () => {
        selectMock.mockResolvedValue("codex");
        const chosen = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)]);
        expect(chosen?.id).toBe("codex");
        expect(selectMock).toHaveBeenCalledTimes(1);
    });

    test("preset short-circuits when the preset agent is available", async () => {
        const chosen = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)], "claude");
        expect(chosen?.id).toBe("claude");
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("an unavailable preset falls back to normal selection", async () => {
        // Preset asks for codex, which isn't installed; only claude is available,
        // so it's used without a prompt.
        const chosen = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", false)], "codex");
        expect(chosen?.id).toBe("claude");
    });
});

describe("watchForCompletion", () => {
    const TIMING = { pollMs: 10, graceMs: 20, killMs: 5000 };
    let dir: string;

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), "watch-completion-"));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    test("terminates the agent shortly after the completion marker appears", async () => {
        const kill = vi.fn((_signal: NodeJS.Signals) => true);
        const stop = watchForCompletion(dir, { kill }, TIMING);
        await writeFile(join(dir, COMPLETION_MARKER_FILE), JSON.stringify({ complete: true }), "utf-8");
        await vi.waitFor(() => expect(kill).toHaveBeenCalledWith("SIGTERM"), { timeout: 2000 });
        stop();
    });

    test("never kills while no valid marker exists", async () => {
        const kill = vi.fn((_signal: NodeJS.Signals) => true);
        const stop = watchForCompletion(dir, { kill }, TIMING);
        await writeFile(join(dir, COMPLETION_MARKER_FILE), JSON.stringify({ complete: false }), "utf-8");
        await new Promise((r) => setTimeout(r, 100));
        expect(kill).not.toHaveBeenCalled();
        stop();
    });

    test("cleanup stops a pending reclaim (the agent exited on its own)", async () => {
        const kill = vi.fn((_signal: NodeJS.Signals) => true);
        const stop = watchForCompletion(dir, { kill }, { ...TIMING, graceMs: 60 });
        await writeFile(join(dir, COMPLETION_MARKER_FILE), JSON.stringify({ complete: true }), "utf-8");
        // Let the poll detect the marker, then "exit" before the grace elapses.
        await new Promise((r) => setTimeout(r, 30));
        stop();
        await new Promise((r) => setTimeout(r, 100));
        expect(kill).not.toHaveBeenCalled();
    });
});

describe("CodexLauncher.buildArgs", () => {
    const MSG = "read the prompt file";
    const codex = new CodexLauncher({ cwd: "/tmp/repo", env: {} });

    test("bypassPermissions runs fully unsandboxed, interactive and headless alike", () => {
        expect(codex.buildArgs(MSG, "bypassPermissions", true)).toEqual([
            "--dangerously-bypass-approvals-and-sandbox",
            MSG,
        ]);
        expect(codex.buildArgs(MSG, "bypassPermissions", false)).toEqual([
            "exec",
            "--dangerously-bypass-approvals-and-sandbox",
            MSG,
        ]);
    });

    test("interactive lower modes keep full access and differ only in approval strictness", () => {
        expect(codex.buildArgs(MSG, "acceptEdits", true)).toEqual([
            "--sandbox",
            "danger-full-access",
            "--ask-for-approval",
            "on-failure",
            MSG,
        ]);
        expect(codex.buildArgs(MSG, "default", true)).toEqual([
            "--sandbox",
            "danger-full-access",
            "--ask-for-approval",
            "untrusted",
            MSG,
        ]);
    });

    test("headless exec collapses default and acceptEdits - there is no prompt to gate on", () => {
        const expected = ["exec", "--sandbox", "danger-full-access", MSG];
        expect(codex.buildArgs(MSG, "default", false)).toEqual(expected);
        expect(codex.buildArgs(MSG, "acceptEdits", false)).toEqual(expected);
    });
});

describe("buildAllLaunchers", () => {
    test("builds both the claude and codex launchers", () => {
        const ids = buildAllLaunchers({ cwd: "/tmp/repo", env: {} }).map((l) => l.id);
        expect(ids).toEqual(["claude", "codex"]);
    });
});

describe("selectPermissionMode", () => {
    test("returns the preset without prompting", async () => {
        const mode: PermissionMode = "acceptEdits";
        expect(await selectPermissionMode(mode)).toBe("acceptEdits");
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("prompts and defaults to fully autonomous when no preset", async () => {
        selectMock.mockResolvedValue("bypassPermissions");
        expect(await selectPermissionMode()).toBe("bypassPermissions");
        const arg = selectMock.mock.calls[0]![0] as { initialValue: string };
        expect(arg.initialValue).toBe("bypassPermissions");
    });
});
