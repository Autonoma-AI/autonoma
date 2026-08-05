import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const CANCEL = Symbol("cancel");
const selectMock = vi.fn();

vi.mock("../../src/ui/prompts", () => ({
    select: (...args: unknown[]) => selectMock(...args),
    isCancel: (v: unknown) => v === CANCEL,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const spawnMock = vi.fn();
vi.mock("cross-spawn", () => ({ default: (...args: unknown[]) => spawnMock(...args) }));

import {
    buildAllLaunchers,
    ClaudeLauncher,
    CodexLauncher,
    isSpawnedByPlanner,
    parsePermissionMode,
    selectLauncher,
    selectPermissionMode,
    SPAWNED_BY_PLANNER_ENV,
    type AgentLauncher,
    type PermissionMode,
} from "../../src/core/coding-agent";

function fakeLauncher(id: string, available: boolean): AgentLauncher {
    return {
        id,
        label: `Agent ${id}`,
        isAvailable: () => Promise.resolve(available),
        registerMcpServer: () => Promise.resolve({ env: {} }),
        launch: () => Promise.resolve(0),
    };
}

interface SpawnCall {
    command: string;
    args: string[];
    env: NodeJS.ProcessEnv;
    stdio: unknown;
}

let spawnCalls: SpawnCall[] = [];
/** Exit code each spawned subcommand reports, keyed by its first argument pair. */
let exitCodes: Map<string, number>;
/** stdout each spawned subcommand emits, keyed the same way. */
let stdouts: Map<string, string>;

/** The key a spawn is looked up by: the subcommand path, e.g. "mcp add". */
function commandKey(args: string[]): string {
    return args.slice(0, 2).join(" ");
}

/** A stand-in for a spawned process that emits its recorded output and exit code. */
function fakeProcess(args: string[]) {
    const key = commandKey(args);
    const proc = Object.assign(new EventEmitter(), {
        stdout: Readable.from([stdouts.get(key) ?? ""]),
        stderr: Readable.from([""]),
        kill: () => true,
    });
    queueMicrotask(() => {
        // Let the readables drain before the close listener tears the process down.
        setTimeout(() => proc.emit("close", exitCodes.get(key) ?? 0), 0);
    });
    return proc;
}

const REAL_IS_TTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

/**
 * Pretend this process has (or has not) a terminal. The browser sign-in is refused
 * without one, and a test runner never has one - so a test about signing in has to
 * say which world it is in rather than inheriting the runner's.
 */
function withTerminal(present: boolean): void {
    Object.defineProperty(process.stdin, "isTTY", { value: present, configurable: true });
}

function restoreTerminalDetection(): void {
    if (REAL_IS_TTY != null) Object.defineProperty(process.stdin, "isTTY", REAL_IS_TTY);
}

beforeEach(() => {
    withTerminal(true);
    selectMock.mockReset();
    spawnCalls = [];
    exitCodes = new Map();
    stdouts = new Map();
    spawnMock.mockReset();
    spawnMock.mockImplementation(
        (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: unknown }) => {
            spawnCalls.push({ command, args, env: options.env, stdio: options.stdio });
            return fakeProcess(args);
        },
    );
});

afterEach(() => {
    restoreTerminalDetection();
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
    test("no available agents -> no launcher (manual fallback)", async () => {
        const launcher = await selectLauncher([fakeLauncher("claude", false)]);
        expect(launcher).toBeUndefined();
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("exactly one available -> uses it without prompting", async () => {
        const only = fakeLauncher("claude", true);
        const launcher = await selectLauncher([only]);
        expect(launcher).toBe(only);
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("multiple available -> prompts to pick", async () => {
        selectMock.mockResolvedValue("codex");
        const launcher = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)]);
        expect(launcher?.id).toBe("codex");
        expect(selectMock).toHaveBeenCalledTimes(1);
    });

    test("preset short-circuits when the preset agent is available", async () => {
        const launcher = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)], "claude");
        expect(launcher?.id).toBe("claude");
        expect(selectMock).not.toHaveBeenCalled();
    });

    test("an unavailable preset falls back to normal selection", async () => {
        // Preset asks for codex, which isn't installed; only claude is available,
        // so it's used without a prompt.
        const launcher = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", false)], "codex");
        expect(launcher?.id).toBe("claude");
    });

    // Headless has nobody to ask by definition, so a refusal here would cost the run
    // its preview environment - and everything after it would plan tests against an
    // app with nowhere to deploy. Which agent does the work barely matters.
    test("takes the first available when it cannot ask which, rather than none", async () => {
        const claude = fakeLauncher("claude", true);
        const launcher = await selectLauncher([claude, fakeLauncher("codex", true)], undefined, false);

        expect(launcher).toBe(claude);
        expect(selectMock).not.toHaveBeenCalled();
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

const SPEC = { name: "autonoma-onboarding", url: "https://api.example.test/v1/mcp/onboarding" };

describe("ClaudeLauncher.registerMcpServer", () => {
    function claude() {
        return new ClaudeLauncher({ cwd: "/tmp/repo", env: {} });
    }

    test("registers at user scope and carries the bearer header when given a token", async () => {
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}`);

        const registration = await claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        const add = spawnCalls.find((call) => commandKey(call.args) === "mcp add");
        expect(add?.args).toEqual([
            "mcp",
            "add",
            "--transport",
            "http",
            "--scope",
            "user",
            SPEC.name,
            SPEC.url,
            "--header",
            "Authorization: Bearer ask_test",
        ]);
        // The header lives in Claude's own config, so the spawn needs nothing extra.
        expect(registration.env).toEqual({});
    });

    // A token means there is nothing to sign in to, and a browser is exactly what a
    // headless run cannot open.
    test("never signs in when a token was supplied", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);

        await claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
    });

    test("signs in through the browser when there is no token and the server is unauthorized", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);

        await claude().registerMcpServer(SPEC);

        const login = spawnCalls.find((call) => commandKey(call.args) === "mcp login");
        expect(login?.args).toEqual(["mcp", "login", SPEC.name]);
        // The sign-in prints a URL and waits on a callback, so it gets the terminal.
        expect(login?.stdio).toBe("inherit");
    });

    test("skips the sign-in when the server is already connected", async () => {
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}`);

        await claude().registerMcpServer(SPEC);

        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
    });

    // Re-registering an existing server is the normal case after the first run, and
    // `mcp add` exits non-zero for it. `get` is the real verdict.
    test("tolerates an add that fails when the server is registered anyway", async () => {
        exitCodes.set("mcp add", 1);
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}`);

        await expect(claude().registerMcpServer(SPEC)).resolves.toEqual({ env: {} });
        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp remove");
    });

    // `mcp add` will not update an existing registration, so one left from another
    // environment would be inherited in silence and the agent would drive the wrong
    // Autonoma. Seen for real: a server registered against beta, then a run against
    // production.
    test("replaces a registration that points at a different host", async () => {
        stdouts.set("mcp get", "Status: Connected\n  URL: https://api.other.test/v1/mcp");

        await claude().registerMcpServer(SPEC);

        const commands = spawnCalls.map((call) => commandKey(call.args));
        expect(commands).toEqual(["mcp get", "mcp remove", "mcp add", "mcp get"]);
    });

    test("fails when the server is not registered afterwards", async () => {
        exitCodes.set("mcp add", 1);
        exitCodes.set("mcp get", 1);
        stdouts.set("mcp get", "No MCP server found");

        await expect(claude().registerMcpServer(SPEC)).rejects.toThrow(/Could not register/);
    });

    test("fails when the browser sign-in does not complete", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);
        exitCodes.set("mcp login", 1);

        await expect(claude().registerMcpServer(SPEC)).rejects.toThrow(/could not sign in/);
    });

    // Without a terminal the sign-in does not fail, it HANGS - on a browser callback
    // nobody will trigger. Refusing early turns an indefinite stall into an error that
    // names the fix, which is to pass a token instead.
    test("refuses the browser sign-in when there is no terminal, and says to use a token", async () => {
        withTerminal(false);
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);

        await expect(claude().registerMcpServer(SPEC)).rejects.toThrow(/AUTONOMA_API_TOKEN/);
        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
    });

    test("still registers headlessly when a token was passed", async () => {
        withTerminal(false);

        await expect(claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" })).resolves.toEqual({ env: {} });
    });
});

describe("CodexLauncher.registerMcpServer", () => {
    function codex() {
        return new CodexLauncher({ cwd: "/tmp/repo", env: {} });
    }

    // Codex stores the NAME of the variable holding the token, so the value has to be
    // present in the spawned agent's environment.
    test("registers a streamable HTTP server and hands back the token env", async () => {
        const registration = await codex().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        expect(spawnCalls[0]?.args).toEqual([
            "mcp",
            "add",
            SPEC.name,
            "--url",
            SPEC.url,
            "--bearer-token-env-var",
            "AUTONOMA_MCP_TOKEN",
        ]);
        expect(registration.env).toEqual({ AUTONOMA_MCP_TOKEN: "ask_test" });
    });

    test("signs in through the browser when there is no token", async () => {
        const registration = await codex().registerMcpServer(SPEC);

        expect(spawnCalls[0]?.args).toEqual(["mcp", "add", SPEC.name, "--url", SPEC.url]);
        expect(spawnCalls[1]?.args).toEqual(["mcp", "login", SPEC.name]);
        expect(registration.env).toEqual({});
    });

    test("fails when the registration itself fails", async () => {
        exitCodes.set("mcp add", 1);

        await expect(codex().registerMcpServer(SPEC)).rejects.toThrow(/Could not register/);
    });

    test("refuses the browser sign-in when there is no terminal", async () => {
        withTerminal(false);

        await expect(codex().registerMcpServer(SPEC)).rejects.toThrow(/AUTONOMA_API_TOKEN/);
        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
    });
});

describe("the recursion guard", () => {
    test("marks the environment of every agent it spawns", async () => {
        const claude = new ClaudeLauncher({ cwd: "/tmp/repo", env: { PATH: "/usr/bin" } });

        await claude.launch({ message: "do the thing", permissionMode: "bypassPermissions", interactive: false });

        expect(spawnCalls[0]?.env).toMatchObject({ PATH: "/usr/bin", [SPAWNED_BY_PLANNER_ENV]: "1" });
    });

    // Otherwise: an agent runs the CLI, the CLI spawns an agent, that agent runs the
    // CLI. Every turn of that loop is a long, expensive run.
    test("refuses to launch from inside an agent it spawned", async () => {
        const claude = new ClaudeLauncher({ cwd: "/tmp/repo", env: { [SPAWNED_BY_PLANNER_ENV]: "1" } });

        await expect(
            claude.launch({ message: "do the thing", permissionMode: "bypassPermissions", interactive: true }),
        ).rejects.toThrow(/Refusing to launch/);
        expect(spawnCalls).toHaveLength(0);
    });

    test("carries a registration's env through to the agent", async () => {
        const claude = new ClaudeLauncher({ cwd: "/tmp/repo", env: {} });

        await claude.launch({
            message: "do the thing",
            permissionMode: "bypassPermissions",
            interactive: false,
            env: { AUTONOMA_MCP_TOKEN: "ask_test" },
        });

        expect(spawnCalls[0]?.env).toMatchObject({ AUTONOMA_MCP_TOKEN: "ask_test" });
    });

    test("reads the marker off an explicit environment", () => {
        expect(isSpawnedByPlanner({ [SPAWNED_BY_PLANNER_ENV]: "1" })).toBe(true);
        expect(isSpawnedByPlanner({ [SPAWNED_BY_PLANNER_ENV]: "" })).toBe(false);
        expect(isSpawnedByPlanner({})).toBe(false);
    });
});

describe("launch", () => {
    test("hands the watcher the process and stops watching when it exits", async () => {
        const stop = vi.fn();
        const watch = vi.fn(() => stop);
        const claude = new ClaudeLauncher({ cwd: "/tmp/repo", env: {} });

        const code = await claude.launch({
            message: "do the thing",
            permissionMode: "bypassPermissions",
            interactive: true,
            watch,
        });

        expect(watch).toHaveBeenCalledTimes(1);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(code).toBe(0);
    });
});
