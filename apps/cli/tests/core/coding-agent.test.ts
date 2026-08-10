import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let storedAgentId: string | undefined;
const savedPreferences: { agentId?: string }[] = [];
vi.mock("../../src/core/preferences", () => ({
    readPreferences: () => Promise.resolve(storedAgentId == null ? {} : { agentId: storedAgentId }),
    updatePreferences: (update: { agentId?: string }) => {
        savedPreferences.push(update);
        return Promise.resolve();
    },
}));

import {
    buildAllLaunchers,
    ClaudeLauncher,
    CodexLauncher,
    isSpawnedByPlanner,
    parsePermissionMode,
    selectLauncher,
    SPAWNED_BY_PLANNER_ENV,
    type AgentLauncher,
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
/** Throwaway CLAUDE_CONFIG_DIR, so no test can reach the developer's real ~/.claude. */
let configDir: string;
/** Exit code each spawned subcommand reports, keyed by its first argument pair. */
let exitCodes: Map<string, number>;
/** Exit codes for consecutive calls to the same subcommand, consumed in order. */
let exitCodeSequences: Map<string, number[]>;
/** stdout each spawned subcommand emits, keyed the same way. */
let stdouts: Map<string, string>;
/** stderr each spawned subcommand emits, keyed the same way. */
let stderrs: Map<string, string>;

/** The key a spawn is looked up by: the subcommand path, e.g. "mcp add". */
function commandKey(args: string[]): string {
    return args.slice(0, 2).join(" ");
}

/** A stand-in for a spawned process that emits its recorded output and exit code. */
function fakeProcess(args: string[]) {
    const key = commandKey(args);
    const proc = Object.assign(new EventEmitter(), {
        stdout: Readable.from([stdouts.get(key) ?? ""]),
        stderr: Readable.from([stderrs.get(key) ?? ""]),
        kill: () => true,
    });
    const code = exitCodeSequences.get(key)?.shift() ?? exitCodes.get(key) ?? 0;
    queueMicrotask(() => {
        // Let the readables drain before the close listener tears the process down.
        setTimeout(() => proc.emit("close", code), 0);
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

beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "claude-config-"));
    withTerminal(true);
    storedAgentId = undefined;
    savedPreferences.length = 0;
    selectMock.mockReset();
    spawnCalls = [];
    exitCodes = new Map();
    exitCodeSequences = new Map();
    stdouts = new Map();
    stderrs = new Map();
    spawnMock.mockReset();
    spawnMock.mockImplementation(
        (command: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: unknown }) => {
            spawnCalls.push({ command, args, env: options.env, stdio: options.stdio });
            return fakeProcess(args);
        },
    );
});

afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
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

    // Which coding agent someone uses is a fact about their machine, not about the
    // repository they happen to be in - so asking again in the next one asks a
    // question they have already answered.
    test("uses the agent picked last time instead of asking again", async () => {
        storedAgentId = "codex";

        const launcher = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)]);

        expect(launcher?.id).toBe("codex");
        expect(selectMock).not.toHaveBeenCalled();
    });

    // A flag is this run's instruction; a remembered choice is a standing one.
    test("lets --agent override what was remembered", async () => {
        storedAgentId = "codex";

        const launcher = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)], "claude");

        expect(launcher?.id).toBe("claude");
    });

    test("falls back to the picker when the remembered agent is gone", async () => {
        storedAgentId = "codex";
        selectMock.mockResolvedValue("claude");

        const launcher = await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", false)]);

        expect(launcher?.id).toBe("claude");
    });

    test("remembers a deliberate pick", async () => {
        selectMock.mockResolvedValue("codex");

        await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)]);

        expect(savedPreferences).toEqual([{ agentId: "codex" }]);
    });

    // Storing these would answer a question nobody was asked - and answer it wrongly
    // the moment a second agent is installed.
    test("does not remember a choice it made on the user's behalf", async () => {
        await selectLauncher([fakeLauncher("claude", true)]);
        await selectLauncher([fakeLauncher("claude", true), fakeLauncher("codex", true)], undefined, false);

        expect(savedPreferences).toEqual([]);
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

// The handoff is where the run installs the SDK and validates against a live app, and
// Claude Code's own default is not stable - it drops to a cheaper model as the account's
// usage limits approach. Both invocations have to name the model, and so does the env the
// session's subagents read.
describe("ClaudeLauncher model pinning", () => {
    const MSG = "read the prompt file";
    const claude = new ClaudeLauncher({ cwd: "/tmp/repo", env: {} });

    test("names the model in both the interactive and headless invocations", () => {
        expect(claude.buildArgs(MSG, "bypassPermissions", true)).toEqual([
            "--permission-mode",
            "bypassPermissions",
            "--model",
            "opus",
            MSG,
        ]);
        expect(claude.buildArgs(MSG, "bypassPermissions", false)).toEqual([
            "-p",
            MSG,
            "--permission-mode",
            "bypassPermissions",
            "--model",
            "opus",
            "--verbose",
        ]);
    });

    test("pins the subagent model too, over anything the developer's shell set", async () => {
        const inherited = new ClaudeLauncher({ cwd: "/tmp/repo", env: { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" } });

        await inherited.launch({ message: MSG, permissionMode: "bypassPermissions", interactive: false });

        expect(spawnCalls[0]?.env).toMatchObject({ CLAUDE_CODE_SUBAGENT_MODEL: "opus" });
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

const SPEC = {
    name: "autonoma-onboarding",
    url: "https://api.example.test/v1/mcp/onboarding",
    browserSignIn: true,
};

/** A headless registration: no browser to sign in with, so the token is the credential. */
const HEADLESS_SPEC = { ...SPEC, browserSignIn: false, apiToken: "ask_test" };

describe("ClaudeLauncher.registerMcpServer", () => {
    function claude() {
        return new ClaudeLauncher({ cwd: "/tmp/repo", env: { CLAUDE_CONFIG_DIR: configDir } });
    }

    test("registers at user scope and carries the bearer header when there is no browser", async () => {
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}`);

        const registration = await claude().registerMcpServer(HEADLESS_SPEC);

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

    // A browser is exactly what a headless run cannot open, so the header is the only
    // credential on that path.
    test("never signs in when there is no browser to sign in with", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);

        await claude().registerMcpServer(HEADLESS_SPEC);

        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
    });

    // Interactively the sign-in is preferred even though the run is holding a token,
    // so the registration goes in WITHOUT the header to leave room for it.
    test("signs in through the browser when the server is unauthorized", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);

        await claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        const add = spawnCalls.find((call) => commandKey(call.args) === "mcp add");
        expect(add?.args).not.toContain("--header");
        const login = spawnCalls.find((call) => commandKey(call.args) === "mcp login");
        expect(login?.args).toEqual(["mcp", "login", SPEC.name]);
        // The sign-in prints a URL and waits on a paste, so it keeps stdin and stdout.
        // stderr is piped so its diagnosis can be quoted back rather than only shown.
        expect(login?.stdio).toEqual(["inherit", "inherit", "pipe"]);
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

    // A shell that cannot run the binary is a broken installation, not a rejected
    // registration. Seen on Windows, where an npm shim resolved to a path cmd.exe
    // refused to run - and the reader was pointed at the MCP server instead.
    test("blames the installation when the client binary cannot be run", async () => {
        exitCodes.set("mcp add", 1);
        exitCodes.set("mcp get", 1);
        stderrs.set("mcp get", "'C:\\npm\\claude.exe' is not recognized as an internal or external command,\n");

        await expect(claude().registerMcpServer(SPEC)).rejects.toThrow(
            /Claude Code is on your PATH but could not be run/,
        );
    });

    // The sign-in is a convenience over a credential the run already holds. Losing the
    // whole run to a browser that would not open is the worse outcome - and because a
    // failed `mcp login` clears whatever credentials the client had, re-adding with the
    // header also repairs the registration the attempt just broke.
    test("falls back to the run's API token when the browser sign-in fails", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);
        exitCodes.set("mcp login", 1);

        const registration = await claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        expect(registration.env).toEqual({});
        const adds = spawnCalls.filter((call) => commandKey(call.args) === "mcp add");
        expect(adds).toHaveLength(2);
        expect(adds[1]?.args).toContain("Authorization: Bearer ask_test");
        // The first registration has to go: `mcp add` will not update one in place.
        expect(spawnCalls.map((call) => commandKey(call.args))).toContain("mcp remove");
    });

    // Without it, an operator reading telemetry sees "exit 1" and nothing else - which
    // is exactly how this failed unexplained across a whole fleet of runs.
    test("quotes the client's own diagnosis when the sign-in fails", async () => {
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);
        exitCodes.set("mcp login", 1);
        stderrs.set("mcp login", "Couldn't reach the authorization server\n");

        await expect(claude().registerMcpServer(SPEC)).rejects.toThrow(
            /exit 1: Couldn't reach the authorization server/,
        );
    });

    test("fails when the sign-in does not complete and there is no token to fall back on", async () => {
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

    // Verified against claude 2.1.226 against the live server: with a header set, `mcp
    // get` reports "Failed to connect ... OAuth fallback is disabled when
    // headers.Authorization is set"; with it removed, the same server reports "Needs
    // authentication" and `mcp login` becomes possible again. So a token that later
    // stops working would otherwise be unrecoverable - the sign-in meant to replace it
    // cannot run while it is there.
    test("clears a bearer header left by an earlier run, so the sign-in is possible at all", async () => {
        stdouts.set(
            "mcp get",
            `Status: Failed to connect\n  URL: ${SPEC.url}\n  Headers:\n    Authorization: Bearer stale`,
        );
        exitCodes.set("mcp login", 1);

        await claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        const commands = spawnCalls.map((call) => commandKey(call.args));
        expect(commands).toContain("mcp remove");
        expect(commands.indexOf("mcp remove")).toBeLessThan(commands.indexOf("mcp login"));
    });

    // The other half of that trade: a header that still works is a working credential,
    // and tearing it down would buy a browser round-trip every run for nothing.
    test("leaves a header that still connects alone", async () => {
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}\n  Headers:\n    Authorization: Bearer good`);

        await claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        const commands = spawnCalls.map((call) => commandKey(call.args));
        expect(commands).not.toContain("mcp login");
        expect(commands).not.toContain("mcp remove");
    });

    // Claude caches a needs-auth verdict per server NAME and then skips connecting on
    // every later session, whatever the registration now holds - and the health check
    // above is what writes it. Leaving it there produces a server that reports
    // Connected, answers tool calls over HTTP, and is still invisible to the agent.
    test("forgets the cached needs-auth verdict that would hide the server from the agent", async () => {
        const cachePath = join(configDir, "mcp-needs-auth-cache.json");
        await writeFile(cachePath, JSON.stringify({ [SPEC.name]: { timestamp: 1 }, other: { timestamp: 2 } }));
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}`);

        await new ClaudeLauncher({ cwd: "/tmp/repo", env: { CLAUDE_CONFIG_DIR: configDir } }).registerMcpServer(SPEC);

        // Only this server's verdict goes; another server's is none of our business.
        expect(JSON.parse(await readFile(cachePath, "utf-8"))).toEqual({ other: { timestamp: 2 } });
    });

    // It reaches into another tool's internal state, so every way that can go wrong has
    // to leave an otherwise-fine registration standing.
    test("survives a missing or unreadable needs-auth cache", async () => {
        stdouts.set("mcp get", `Status: Connected\n  URL: ${SPEC.url}`);

        // Nothing written yet, so the file is simply absent.
        await expect(claude().registerMcpServer(SPEC)).resolves.toEqual({ env: {} });

        await writeFile(join(configDir, "mcp-needs-auth-cache.json"), "not json at all");
        await expect(claude().registerMcpServer(SPEC)).resolves.toEqual({ env: {} });
    });

    test("still registers headlessly when a token was passed", async () => {
        withTerminal(false);

        await expect(claude().registerMcpServer(HEADLESS_SPEC)).resolves.toEqual({ env: {} });
    });

    // An interactive run on a machine with no terminal cannot sign in either, and the
    // token it is holding is a better answer than ending the run.
    test("falls back to the token when there is no terminal to sign in from", async () => {
        withTerminal(false);
        stdouts.set("mcp get", `Status: Needs authentication\n  URL: ${SPEC.url}`);

        await expect(claude().registerMcpServer({ ...SPEC, apiToken: "ask_test" })).resolves.toEqual({ env: {} });
        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
    });
});

describe("CodexLauncher.registerMcpServer", () => {
    function codex() {
        return new CodexLauncher({ cwd: "/tmp/repo", env: {} });
    }

    // Codex stores the NAME of the variable holding the token, so the value has to be
    // present in the spawned agent's environment.
    test("registers a streamable HTTP server and hands back the token env", async () => {
        const registration = await codex().registerMcpServer(HEADLESS_SPEC);

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

    // `codex mcp add --url` detects the server's OAuth support and runs the whole flow
    // itself, so the add IS the sign-in. A separate `mcp login` afterwards would only
    // open a second browser flow for a session that is already authorized.
    test("signs in as part of the add, without a second login flow", async () => {
        const registration = await codex().registerMcpServer(SPEC);

        expect(spawnCalls[0]?.args).toEqual(["mcp", "add", SPEC.name, "--url", SPEC.url]);
        expect(spawnCalls.map((call) => commandKey(call.args))).not.toContain("mcp login");
        expect(registration.env).toEqual({});
    });

    // Piping it hid the authorization URL: when the browser fails to open, Codex prints
    // "copy the URL above manually" - and there was no URL above, because we had it.
    test("gives the add the terminal, since it prints a URL and waits on a callback", async () => {
        await codex().registerMcpServer(SPEC);

        expect(spawnCalls[0]?.stdio).toEqual(["inherit", "inherit", "pipe"]);
    });

    // Re-adding overwrites, so the token registration simply replaces the one the
    // sign-in was folded into - and the spawn now needs the token in its env. Naming a
    // token env var also stops Codex starting an OAuth flow, which is what makes this
    // survivable on the machine that could not open a browser to begin with.
    test("falls back to the run's API token when the add's sign-in fails", async () => {
        exitCodeSequences.set("mcp add", [1, 0]);

        const registration = await codex().registerMcpServer({ ...SPEC, apiToken: "ask_test" });

        expect(registration.env).toEqual({ AUTONOMA_MCP_TOKEN: "ask_test" });
        const adds = spawnCalls.filter((call) => commandKey(call.args) === "mcp add");
        expect(adds).toHaveLength(2);
        expect(adds[1]?.args).toContain("--bearer-token-env-var");
    });

    test("quotes what the add said when it fails and there is no token to fall back on", async () => {
        exitCodes.set("mcp add", 1);
        stderrs.set("mcp add", "Browser launch failed; please copy the URL above manually.\n");

        await expect(codex().registerMcpServer(SPEC)).rejects.toThrow(/Browser launch failed/);
    });

    // A binary that will not execute is a broken installation, and the token fallback
    // would apply itself through that same binary - so "Set AUTONOMA_API_TOKEN" is the
    // wrong instruction. Codex folds its sign-in into `mcp add`, which is the path that
    // used to answer a shell error with authorization advice.
    test("tells the user to reinstall, not to set a token, when the binary will not run", async () => {
        exitCodes.set("mcp add", 1);
        stderrs.set("mcp add", "codex: command not found\n");

        const error: unknown = await codex()
            .registerMcpServer(SPEC)
            .then(() => undefined)
            .catch((err: unknown) => err);

        expect(String(error)).toMatch(/Codex CLI is on your PATH but could not be run/);
        expect(String(error)).not.toMatch(/AUTONOMA_API_TOKEN/);
    });

    test("fails when the token registration itself fails", async () => {
        exitCodes.set("mcp add", 1);

        await expect(codex().registerMcpServer(HEADLESS_SPEC)).rejects.toThrow(/Could not register/);
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
