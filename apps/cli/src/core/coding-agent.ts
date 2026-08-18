import type { StdioOptions } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import which from "which";
import * as p from "../ui/prompts";
import { isSpawnedByPlanner as spawnedByPlanner, SPAWNED_BY_PLANNER_ENV } from "./agent-env";
import { debugLog } from "./debug";
import { captureLog } from "./logs";
import { readPreferences, updatePreferences } from "./preferences";
import { trySpawn } from "./try-spawn";

/** Ceiling on a client's own `mcp` subcommands, which talk to the server to health-check it. */
const MCP_COMMAND_TIMEOUT_MS = 60_000;

/**
 * How much of an attached subcommand's stderr is kept for reporting. Enough for the
 * client's own diagnosis and a short stack; a chatty child cannot grow the buffer
 * past it.
 */
const ATTACHED_STDERR_CAP = 4000;

/**
 * Set on the environment of every coding agent this CLI spawns, and refused at spawn
 * time when it is already present. Without it a loop is trivially reachable: an agent
 * runs the CLI, the CLI spawns an agent, that agent runs the CLI. Each turn of the
 * loop is a long, expensive run, so the guard is a hard refusal rather than a warning.
 */
export { SPAWNED_BY_PLANNER_ENV } from "./agent-env";

/** Env var a Codex registration reads its bearer token from at connect time. */
const CODEX_BEARER_TOKEN_ENV = "AUTONOMA_MCP_TOKEN";

/**
 * What `claude mcp get` prints for a server it can reach and is authorized against.
 * Matched as a substring purely to decide whether to run an interactive `login`, so
 * the brittleness is bounded: read it wrong in one direction and the user sees one
 * unnecessary browser sign-in; in the other, the agent starts with an unauthorized
 * server and fails loudly on its first tool call. Neither is silent.
 */
const CLAUDE_CONNECTED_MARKER = "Connected";

/**
 * Output that means the binary is present and intact and the OS refused to run it
 * anyway: an execution policy, an endpoint-security agent, a noexec mount. Split out
 * from the patterns below because it is the half of them reinstalling cannot fix.
 */
const EXECUTION_REFUSED_PATTERNS = [/\bEPERM\b/, /\bEACCES\b/, /\bENOEXEC\b/];

/**
 * Output that means the client's own binary could not be executed at all, rather than
 * anything about the server it was asked to register. Patterns rather than a set: each
 * is a fragment of a longer line from a shell or the OS. Seen in the wild on Windows,
 * where an npm shim resolved to a path cmd.exe refused to run - reported as "could not
 * register the MCP server", which sent the reader looking in entirely the wrong place.
 */
const CLIENT_NOT_EXECUTABLE_PATTERNS = [
    /is not recognized as an internal or external command/i,
    /command not found/i,
    /\bENOENT\b/,
    /no such file or directory/i,
    ...EXECUTION_REFUSED_PATTERNS,
];

/**
 * What `claude mcp get` prints for a registration carrying a bearer header.
 *
 * Claude turns OAuth off entirely while one is set - "OAuth fallback is disabled when
 * headers.Authorization is set" - so a header left behind by an earlier run's token
 * fallback makes `mcp login` impossible. Without clearing it first, a token that later
 * goes bad can never be replaced by a sign-in, and the run is stuck re-applying the
 * credential that stopped working.
 */
const CLAUDE_AUTH_HEADER_MARKER = "Authorization:";

/**
 * Where Claude Code remembers, keyed by server NAME, that a server needed
 * authorization. Undocumented internal state of another tool, so everything that
 * touches it is best effort.
 */
const CLAUDE_NEEDS_AUTH_CACHE_FILE = "mcp-needs-auth-cache.json";

/**
 * Model the spawned Claude session runs on, as an alias rather than a pinned id so it
 * tracks the latest Opus release instead of needing a bump here every time one ships.
 *
 * Pinned deliberately rather than left to the client's own default, which is not stable:
 * Claude Code picks a model from the account's plan and silently drops to a cheaper one
 * as usage limits approach. This handoff is the most consequential part of a planner run
 * - it installs the SDK, boots the app, and validates against a live environment - and a
 * mid-run downgrade shows up as the agent quietly getting worse at it, with nothing in
 * the output saying why. Passed in argv, which outranks an `ANTHROPIC_MODEL` inherited
 * from the developer's shell.
 */
const CLAUDE_MODEL = "opus";

/**
 * Env var Claude Code reads the model for its own subagents from. Set to the same model:
 * subagents otherwise default to a cheaper tier, and this run delegates real work to them
 * (repo exploration, config edits), so the ceiling has to hold there too.
 */
const CLAUDE_SUBAGENT_MODEL_ENV = "CLAUDE_CODE_SUBAGENT_MODEL";

/**
 * The autonomy the interactive agent runs with, in plain-language labels that map
 * to Claude's `--permission-mode`. `plan` (read-only) is intentionally excluded -
 * it can't implement anything, so it's irrelevant to a handoff whose whole job is
 * to write code.
 */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export const DEFAULT_PERMISSION_MODE: PermissionMode = "bypassPermissions";

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
    default: "Approve each command",
    acceptEdits: "Auto-edit files, approve commands",
    bypassPermissions: "Fully autonomous",
};

/** An MCP server to register with a coding agent before it is spawned. */
export interface McpServerSpec {
    /** Name the client registers it under, and the name prompts must call it by. */
    name: string;
    /** Streamable HTTP endpoint. */
    url: string;
    /**
     * The run's own credential, sent as a bearer header. Pass it whenever the run
     * holds one: headless it is the only way to authorize, and interactively it is
     * what a failed browser sign-in falls back to.
     */
    apiToken?: string;
    /**
     * Try the client's own browser sign-in before falling back to {@link apiToken}.
     * The sign-in is the better credential - scoped to the user, revocable by signing
     * out - but it needs someone at the keyboard to approve it, so this is true only
     * where there is one.
     */
    browserSignIn: boolean;
}

/** What registering a server leaves the spawned agent needing. */
export interface McpRegistration {
    /**
     * Extra environment the agent must be spawned with for the registration to work.
     * Codex stores the NAME of the env var holding its bearer token rather than the
     * token itself, so the value has to be present at connect time; Claude writes the
     * header into its own config and needs nothing.
     */
    env: Record<string, string>;
}

/** The subset of a spawned process this module signals. */
export interface KillableProcess {
    kill(signal: NodeJS.Signals): boolean;
}

/** One run of a coding agent. */
export interface LaunchRequest {
    /**
     * What the agent is started on. Callers own this text - a launcher knows how to
     * run an agent, not what to ask it for.
     */
    message: string;
    permissionMode: PermissionMode;
    /**
     * Attach this process's stdio so the developer watches and steers it (and the
     * agent can surface its own login). Otherwise it runs headless and autonomous,
     * its output piped to the CLI's stdout/stderr.
     */
    interactive: boolean;
    /**
     * Extra environment for this run, on top of what the launcher was built with.
     * This is where an {@link McpRegistration}'s env goes, so a registration made
     * moments earlier reaches the agent that has to use it.
     */
    env?: Record<string, string>;
    /**
     * Watch the running agent and decide when it is done. An interactive session
     * never exits on its own - it sits open after its final message - so a caller
     * with an out-of-band completion signal passes it here and gets a cleanup
     * function back, invoked when the process exits.
     */
    watch?: (proc: KillableProcess) => () => void;
}

/**
 * The one injection seam for handing work to a coding agent. A launcher knows how to
 * detect its agent on the machine, register an MCP server with it, and run it attached
 * to the terminal. Codex (and other agents) slot in by implementing this interface;
 * the flows that use it never change.
 */
export interface AgentLauncher {
    /** Stable id persisted in state and matched by the `--agent` flag (e.g. "claude"). */
    readonly id: string;
    /** Human label for prompts and announcements (e.g. "Claude Code"). */
    readonly label: string;
    /** Whether the agent's binary is on PATH. */
    isAvailable(): Promise<boolean>;
    /**
     * Register an MCP server with this client so a FRESH session picks it up. This is
     * the whole reason the CLI can do what a running agent cannot: a client only loads
     * its server list at startup, so a session that registers a server never sees it -
     * but a CLI process is not a session, and the agent it spawns afterwards is new.
     */
    registerMcpServer(spec: McpServerSpec): Promise<McpRegistration>;
    /** Run the agent, resolving once it exits - or once it turns out it cannot start. */
    launch(request: LaunchRequest): Promise<LaunchResult>;
}

/** What one launch did, from the outside. */
export interface LaunchResult {
    /**
     * Whether a process was created at all. Callers that decide what to do next need
     * this separately from the exit code, because an agent the caller's own watcher
     * killed once its work was done also reports no code.
     */
    started: boolean;
    /** The process's exit code, absent when it was signalled or never ran. */
    exitCode: number | undefined;
}

export interface LauncherOptions {
    /** Directory the agent runs in - the developer's repo. */
    cwd: string;
    /** Env the agent (and any app it boots) inherits, including AUTONOMA_SHARED_SECRET. */
    env: NodeJS.ProcessEnv;
}

const CLAUDE_ID = "claude";
const CODEX_ID = "codex";

/** Result of running one of a client's own subcommands. */
interface CommandResult {
    code: number | undefined;
    stdout: string;
    stderr: string;
}

/** Exit code and captured stderr of a subcommand that was given the terminal. */
interface AttachedResult {
    code: number | undefined;
    stderr: string;
}

/** Outcome of a client's own browser sign-in. A failure here is recoverable. */
interface SignInResult {
    ok: boolean;
    /** Parenthesised detail to append to a message, or "" when there is none to add. */
    detail: string;
    /**
     * The client's own binary would not run. No credential rescues that - the token
     * fallback would apply itself through the same binary - so this is a broken
     * installation to report, not an authorization step to retry differently.
     */
    clientUnusable: boolean;
}

/** Authorization that came from the run's own API token, not a browser sign-in. */
interface TokenAuthorization {
    apiToken: string;
}

/** How a server ended up authorized, which decides what the spawn needs in its env. */
type Authorization = { via: "sign-in" } | ({ via: "token" } & TokenAuthorization);

/**
 * Whether this process is itself running inside an agent the CLI spawned. Callers
 * check it before handing off, so the refusal is a clear message rather than a
 * surprise several minutes into a nested run.
 */
export function isSpawnedByPlanner(env: NodeJS.ProcessEnv = process.env): boolean {
    return spawnedByPlanner(env);
}

/**
 * Shared launcher machinery: detect the binary on PATH, register servers through the
 * client's own `mcp` subcommands, then spawn it and manage the terminal handover.
 * Every agent's `launch` is identical except for its argv, so a concrete launcher
 * supplies only `buildArgs` and its MCP registration argv (plus its id/label/binary).
 */
export abstract class BaseLauncher implements AgentLauncher {
    abstract readonly id: string;
    abstract readonly label: string;
    /** The binary to probe on PATH and spawn. */
    protected abstract readonly command: string;

    constructor(protected readonly opts: LauncherOptions) {}

    /**
     * Translate the run into this agent's argv. `interactive` selects the attached-TTY
     * vs headless invocation, which differ per agent (Claude's `-p`, Codex's `exec`).
     */
    abstract buildArgs(message: string, permissionMode: PermissionMode, interactive: boolean): string[];

    /** Register the server with this client, and say what the spawn then needs in its env. */
    abstract registerMcpServer(spec: McpServerSpec): Promise<McpRegistration>;

    async isAvailable(): Promise<boolean> {
        const resolved = await which(this.command, { nothrow: true });
        debugLog("Probed for agent on PATH", { command: this.command, found: resolved != null });
        return resolved != null;
    }

    async launch(request: LaunchRequest): Promise<LaunchResult> {
        if (isSpawnedByPlanner(this.opts.env)) {
            // The env we are about to hand the agent already carries the marker, so this
            // CLI is running inside an agent the planner spawned. Refuse rather than
            // start another turn of the loop.
            throw new Error(
                `Refusing to launch ${this.label}: this planner run was itself started by an agent the planner ` +
                    `spawned (${SPAWNED_BY_PLANNER_ENV} is set). Run the planner directly instead.`,
            );
        }

        debugLog(`Launching ${this.label}`, {
            permissionMode: request.permissionMode,
            interactive: request.interactive,
        });
        const args = this.buildArgs(request.message, request.permissionMode, request.interactive);
        const stdio: StdioOptions = request.interactive ? "inherit" : ["ignore", "inherit", "inherit"];

        return new Promise<LaunchResult>((resolve) => {
            const attempt = trySpawn(this.command, args, {
                cwd: this.opts.cwd,
                env: this.spawnEnv(request.env),
                stdio,
            });
            if (!attempt.started) {
                // Nothing to watch and nothing to stop: there is no process. The run
                // continues without the handoff rather than dying on the errno.
                this.reportLaunchFailure(attempt.error);
                resolve({ started: false, exitCode: undefined });
                return;
            }

            const proc = attempt.proc;
            const stopWatching = request.watch?.(proc) ?? (() => {});
            proc.on("error", (err: Error) => {
                this.reportLaunchFailure(err);
                stopWatching();
                resolve({ started: false, exitCode: undefined });
            });
            proc.on("close", (code) => {
                debugLog(`${this.label} exited`, { code });
                stopWatching();
                resolve({ started: true, exitCode: code ?? undefined });
            });
        });
    }

    /**
     * Say why the agent never started, in the same words on both the paths a spawn can
     * fail by. The raw text is an errno, so it goes through the same restatement the
     * client's own subcommands get - "could not be run", and what to do about it.
     */
    private reportLaunchFailure(err: Error): void {
        debugLog(`${this.label} failed to spawn`, { err });
        captureLog("error", "Coding agent failed to spawn", { source: "coding_agent", agent: this.id });
        p.log.error(`Couldn't launch ${this.label}: ${explainFailureReason(err.message, this.label)}`);
    }

    /**
     * The env the agent runs with: what the CLI was given (so the canonical shared
     * secret reaches the app and the signed `sdk` calls), whatever this run adds
     * (an MCP registration's token), plus the recursion marker.
     */
    protected spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
        return { ...this.opts.env, ...extra, [SPAWNED_BY_PLANNER_ENV]: "1" };
    }

    /**
     * Run one of this client's own subcommands and capture its output. Never attached
     * to the terminal: these are configuration calls whose result the CLI inspects,
     * not the handoff itself.
     */
    protected runCommand(args: string[]): Promise<CommandResult> {
        debugLog(`Running ${this.command} ${args[0] ?? ""}`, { args });
        return new Promise<CommandResult>((resolve) => {
            const attempt = trySpawn(this.command, args, {
                cwd: this.opts.cwd,
                env: this.opts.env,
                stdio: ["ignore", "pipe", "pipe"],
                timeout: MCP_COMMAND_TIMEOUT_MS,
            });
            if (!attempt.started) {
                resolve({ code: undefined, stdout: "", stderr: attempt.error.message });
                return;
            }

            const proc = attempt.proc;
            let stdout = "";
            let stderr = "";
            proc.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
            proc.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
            proc.on("error", (err: Error) => {
                debugLog(`${this.command} ${args[0] ?? ""} failed to spawn`, { err });
                resolve({ code: undefined, stdout, stderr: err.message });
            });
            proc.on("close", (code) => resolve({ code: code ?? undefined, stdout, stderr }));
        });
    }

    /**
     * Sign this client in to a server through its own browser flow.
     *
     * Never throws. A sign-in is a convenience over the credential the run is already
     * holding, so every way it can fail - no terminal to open a browser from, a
     * client that exits non-zero - resolves to a result the caller can fall back on.
     * Refusing without a terminal is still the right call: the flow prints a URL and
     * blocks on a callback, so with nobody at the keyboard it would not fail, it would
     * hang indefinitely on a prompt nobody can see.
     */
    protected async signIn(serverName: string): Promise<SignInResult> {
        if (process.stdin.isTTY !== true) {
            return { ok: false, detail: " (no terminal to run a browser sign-in from)", clientUnusable: false };
        }

        p.log.info(`Authorizing ${this.label} with Autonoma - approve it in the browser that opens.`);
        const login = await this.runAttached(["mcp", "login", serverName]);
        if (login.code === 0) return { ok: true, detail: "", clientUnusable: false };

        debugLog(`${this.label} sign-in failed`, { serverName, code: login.code, stderr: login.stderr });
        return {
            ok: false,
            detail: describeSignInFailure(login, this.label),
            clientUnusable: isClientNotExecutable(login.stderr),
        };
    }

    /**
     * The credential a registration must have when no browser sign-in is on the table.
     * Its absence is a configuration error worth stating now, rather than an
     * unauthorized server the spawned agent discovers on its first tool call.
     */
    protected requireHeadlessToken(spec: McpServerSpec): string {
        if (spec.apiToken != null) return spec.apiToken;
        throw new Error(
            `Cannot authorize the ${spec.name} MCP server for ${this.label} without a terminal: a browser ` +
                `sign-in needs someone to approve it. Set AUTONOMA_API_TOKEN so the run authorizes with an ` +
                `API key instead.`,
        );
    }

    /**
     * Authorize a server that a browser sign-in was preferred for, and say how it
     * ended up authorized so the caller can register it accordingly.
     *
     * A failed sign-in is not the end of the run. The token that falls back here is
     * the same one that already authorized every API call made to get this far, so
     * refusing to use it loses the run to a browser that would not open. It also
     * repairs what the attempt broke: a failed `mcp login` clears whatever stored
     * credentials the client had, which is why a first failure used to make every
     * later run fail too.
     */
    protected async authorizeInteractively(spec: McpServerSpec): Promise<Authorization> {
        const signIn = await this.signIn(spec.name);
        if (signIn.ok) return { via: "sign-in" };
        return { via: "token", ...this.fallBackToToken(spec, signIn) };
    }

    /**
     * Switch to the run's own API token after a browser sign-in did not happen, for
     * whatever reason - it was refused, it failed, or the client folded it into a
     * registration that failed. Throws only when there is no token to switch to.
     */
    protected fallBackToToken(spec: McpServerSpec, signIn: SignInResult): TokenAuthorization {
        const detail = signIn.detail;
        if (signIn.clientUnusable) {
            throw new Error(`Could not register the ${spec.name} MCP server with ${this.label}:${detail}`);
        }

        if (spec.apiToken == null) {
            throw new Error(
                `${this.label} could not sign in to the ${spec.name} MCP server${detail}, and this run ` +
                    `has no API token to fall back on. Set AUTONOMA_API_TOKEN and run again.`,
            );
        }

        captureLog("warn", "Browser sign-in failed; authorizing the MCP server with the run's API token", {
            source: "coding_agent",
            agent: this.id,
            detail,
        });
        p.log.warn(
            `${this.label} couldn't sign in to the ${spec.name} MCP server${detail}. Authorizing it with ` +
                `this run's API token instead.`,
        );
        return { apiToken: spec.apiToken };
    }

    /**
     * Run a subcommand that hands the terminal over - an interactive OAuth sign-in.
     * The client prints a URL, opens a browser and waits on the callback, so stdin and
     * stdout stay attached to this process.
     *
     * stderr is the exception: it is piped so the client's own diagnosis can be quoted
     * back and reported, and echoed as it arrives so the user still watches it live.
     * Inheriting it would put that text on screen and nowhere else, which is what made
     * every sign-in failure look identical from the outside.
     */
    protected runAttached(args: string[]): Promise<AttachedResult> {
        debugLog(`Running ${this.command} ${args.join(" ")} attached`);
        return new Promise<AttachedResult>((resolve) => {
            const attempt = trySpawn(this.command, args, {
                cwd: this.opts.cwd,
                env: this.opts.env,
                stdio: ["inherit", "inherit", "pipe"],
            });
            if (!attempt.started) {
                resolve({ code: undefined, stderr: attempt.error.message });
                return;
            }

            const proc = attempt.proc;
            let stderr = "";
            proc.stderr?.on("data", (chunk: Buffer) => {
                process.stderr.write(chunk);
                if (stderr.length < ATTACHED_STDERR_CAP) stderr += chunk.toString();
            });
            proc.on("error", (err: Error) => {
                debugLog(`${this.command} ${args[0] ?? ""} failed to spawn`, { err });
                resolve({ code: undefined, stderr: err.message });
            });
            proc.on("close", (code) => resolve({ code: code ?? undefined, stderr }));
        });
    }
}

/**
 * Claude Code launcher. Authentication for the agent itself is Claude's own concern -
 * it surfaces its login flow live in the attached terminal.
 */
export class ClaudeLauncher extends BaseLauncher {
    readonly id = CLAUDE_ID;
    readonly label = "Claude Code";
    protected readonly command = CLAUDE_ID;

    buildArgs(message: string, permissionMode: PermissionMode, interactive: boolean): string[] {
        // Headless uses `-p` (autonomous print mode) with verbose logs; interactive
        // attaches the REPL. Both take the same `--permission-mode` and `--model`.
        return interactive
            ? ["--permission-mode", permissionMode, "--model", CLAUDE_MODEL, message]
            : ["-p", message, "--permission-mode", permissionMode, "--model", CLAUDE_MODEL, "--verbose"];
    }

    /** Carry the model floor into the session's subagents, which read it from the env. */
    protected override spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
        return { ...super.spawnEnv(extra), [CLAUDE_SUBAGENT_MODEL_ENV]: CLAUDE_MODEL };
    }

    /**
     * Headless registers with the bearer header outright - there is no browser to sign
     * in with. Interactively the registration goes in without one so the client's own
     * sign-in can claim it, and the header is applied only if that sign-in fails.
     */
    async registerMcpServer(spec: McpServerSpec): Promise<McpRegistration> {
        const registration = await this.register(spec);
        // Only on the way out, and on every successful path: a stale verdict blocks the
        // agent no matter which of them got us here.
        await this.forgetNeedsAuthVerdict(spec.name);
        return registration;
    }

    /**
     * Forget Claude's cached "this server needs authorization" verdict for this name.
     *
     * Claude caches that verdict per server NAME and then skips connecting on every
     * later session - "Skipping connection (cached needs-auth)" in its own debug log -
     * whatever the registration now holds. The health check this class runs to decide
     * whether to sign in is itself what writes the entry, and a successful one does not
     * clear it. Without this, a registration can report Connected, answer tool calls
     * over HTTP, and still be invisible to the agent we spawn: no Autonoma tools, and
     * nothing on screen saying why.
     *
     * Best effort by design. It reaches into another tool's internal state, so a missing
     * file, a changed format or an unwritable home degrades to a debug line rather than
     * failing a registration that is otherwise fine.
     */
    private async forgetNeedsAuthVerdict(serverName: string): Promise<void> {
        const configDir = this.opts.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
        const cachePath = join(configDir, CLAUDE_NEEDS_AUTH_CACHE_FILE);
        try {
            const parsed: unknown = JSON.parse(await readFile(cachePath, "utf-8"));
            if (!isRecord(parsed) || !(serverName in parsed)) return;

            const remaining = { ...parsed };
            delete remaining[serverName];
            await writeFile(cachePath, JSON.stringify(remaining), "utf-8");
            debugLog("Cleared a cached needs-auth verdict", { server: serverName });
        } catch (err) {
            debugLog("Could not clear the cached needs-auth verdict", { cachePath, err });
        }
    }

    private async register(spec: McpServerSpec): Promise<McpRegistration> {
        await this.dropRegistrationPointingElsewhere(spec);

        if (!spec.browserSignIn) {
            await this.addServer(spec, this.requireHeadlessToken(spec));
            return { env: {} };
        }

        const registered = await this.addServer(spec, undefined);
        if (registered.includes(CLAUDE_CONNECTED_MARKER)) return { env: {} };

        // Connected is the only reason to keep a header: it means an earlier run's
        // fallback token still works, and re-doing the sign-in would cost a browser
        // round-trip for nothing. Anything else and the header has to go, because it is
        // what stops the sign-in below from being possible at all.
        const authorizable = registered.includes(CLAUDE_AUTH_HEADER_MARKER)
            ? await this.clearBearerHeader(spec)
            : registered;
        if (authorizable.includes(CLAUDE_CONNECTED_MARKER)) return { env: {} };

        const authorization = await this.authorizeInteractively(spec);
        if (authorization.via === "sign-in") return { env: {} };

        // `mcp add` will not update an existing registration, so the one added moments
        // ago has to go before the header can take its place.
        await this.runCommand(["mcp", "remove", spec.name, "-s", "user"]);
        await this.addServer(spec, authorization.apiToken);
        return { env: {} };
    }

    /**
     * An existing registration is only useful if it points where this run does. `mcp
     * add` will not update one, so a registration left over from another environment
     * would be reused in silence and the agent would work against the wrong Autonoma.
     * Replace it rather than inherit it.
     */
    private async dropRegistrationPointingElsewhere(spec: McpServerSpec): Promise<void> {
        const existing = await this.runCommand(["mcp", "get", spec.name]);
        if (existing.code !== 0 || existing.stdout.includes(spec.url)) return;

        debugLog("Replacing an MCP registration that points elsewhere", { server: spec.name, url: spec.url });
        await this.runCommand(["mcp", "remove", spec.name, "-s", "user"]);
    }

    /**
     * Re-register without the bearer header, so a browser sign-in becomes possible
     * again. Returns what `get` then reported - which may be Connected on its own, if
     * the client still holds OAuth credentials the header had been masking.
     */
    private async clearBearerHeader(spec: McpServerSpec): Promise<string> {
        debugLog("Clearing a bearer header that would block the browser sign-in", { server: spec.name });
        await this.runCommand(["mcp", "remove", spec.name, "-s", "user"]);
        return await this.addServer(spec, undefined);
    }

    /**
     * Add the server and confirm the client actually holds it, returning what `get`
     * reported so the caller can also read whether it is authorized.
     *
     * `mcp add` exits non-zero when the server is already registered, which is the
     * normal case on every run after the first, so its exit code is a hint and `get`
     * is the verdict.
     *
     * `--scope user` and not the default (`local`): the default binds the server to
     * the directory the command ran in. The planner can be invoked from anywhere in a
     * repo, and a server registered against the wrong directory looks exactly like one
     * that was never authorized - the agent simply has no Autonoma tools.
     */
    private async addServer(spec: McpServerSpec, apiToken: string | undefined): Promise<string> {
        const add = ["mcp", "add", "--transport", "http", "--scope", "user", spec.name, spec.url];
        // The token goes in argv, where `ps` can read it for the length of this call,
        // and is then stored in plaintext in Claude's user config. Claude has no
        // env-var-by-name option for headers the way Codex does (`-e/--env` sets a
        // stdio server's subprocess env; `--client-secret` is the OAuth client secret),
        // so there is no alternative here. It is also not new exposure: this is the
        // same AUTONOMA_API_TOKEN the user pasted to start the planner, already in that
        // process's own argv for the whole run, which is far longer than this call.
        if (apiToken != null) add.push("--header", `Authorization: Bearer ${apiToken}`);

        await this.runCommand(add);
        const registered = await this.runCommand(["mcp", "get", spec.name]);
        if (registered.code !== 0) {
            throw new Error(
                `Could not register the ${spec.name} MCP server with ${this.label}: ` +
                    `${describeCommandFailure(registered, this.label)}`,
            );
        }
        return registered.stdout;
    }
}

/**
 * Codex CLI launcher. Authentication for the agent itself is Codex's own concern - it
 * surfaces its login flow live in the attached terminal.
 */
export class CodexLauncher extends BaseLauncher {
    readonly id = CODEX_ID;
    readonly label = "Codex CLI";
    protected readonly command = CODEX_ID;

    /**
     * Codex's autonomy is two orthogonal axes - `--sandbox` (what it may touch) and
     * `--ask-for-approval` (when it pauses) - so we translate the shared,
     * Claude-flavoured `PermissionMode` onto them.
     *
     * The handoff's whole job is to install the SDK, boot the app, and validate
     * against a live DB, so the sandbox is always `danger-full-access` (Codex's
     * `workspace-write` disables network, which breaks the install). The only real
     * knob is approval strictness, which exists only interactively: headless `exec`
     * can't prompt, so `default`/`acceptEdits` collapse to the same autonomous run.
     */
    buildArgs(message: string, permissionMode: PermissionMode, interactive: boolean): string[] {
        if (permissionMode === "bypassPermissions") {
            const bypass = ["--dangerously-bypass-approvals-and-sandbox"];
            return interactive ? [...bypass, message] : ["exec", ...bypass, message];
        }

        const sandbox = ["--sandbox", "danger-full-access"];
        if (!interactive) return ["exec", ...sandbox, message];

        const approval = permissionMode === "acceptEdits" ? "on-failure" : "untrusted";
        return [...sandbox, "--ask-for-approval", approval, message];
    }

    /**
     * Codex speaks streamable HTTP natively, so this needs no `mcp-remote` bridge.
     * `--bearer-token-env-var` stores the NAME of the variable rather than the token,
     * which is why the registration hands an env back for the spawn to carry.
     *
     * `mcp add` is idempotent here in the way that matters: re-adding an existing
     * server overwrites its entry, so a re-run cannot leave a stale URL behind.
     */
    async registerMcpServer(spec: McpServerSpec): Promise<McpRegistration> {
        if (!spec.browserSignIn) {
            const apiToken = this.requireHeadlessToken(spec);
            await this.addServer(spec, apiToken);
            return { env: { [CODEX_BEARER_TOKEN_ENV]: apiToken } };
        }

        const signIn = await this.addServerAndSignIn(spec);
        if (signIn.ok) return { env: {} };

        // Re-adding overwrites, so the token registration simply replaces the one the
        // sign-in was folded into. With a token env var named, `mcp add` registers and
        // stops - it starts no OAuth flow, which is what makes this a viable fallback
        // on a machine that could not open a browser in the first place.
        const authorization = this.fallBackToToken(spec, signIn);
        await this.addServer(spec, authorization.apiToken);
        return { env: { [CODEX_BEARER_TOKEN_ENV]: authorization.apiToken } };
    }

    /**
     * Register the server the interactive way, which for Codex is one step rather than
     * two: given a `--url` and no bearer token, `codex mcp add` detects the server's
     * OAuth support, prints an authorization URL, opens a browser and waits on the
     * callback - all inside the add.
     *
     * Two consequences. It needs the terminal: run through a pipe, the URL it tells the
     * user to "copy above manually" when the browser fails to open goes into a buffer
     * nobody reads, turning a recoverable prompt into a dead end. And a clean exit means
     * the server is registered AND signed in, so following it with `mcp login` would
     * only open a second browser flow for a session that is already authorized.
     */
    private async addServerAndSignIn(spec: McpServerSpec): Promise<SignInResult> {
        if (process.stdin.isTTY !== true) {
            return { ok: false, detail: " (no terminal to run a browser sign-in from)", clientUnusable: false };
        }

        p.log.info(`Authorizing ${this.label} with Autonoma - approve it in the browser that opens.`);
        const added = await this.runAttached(["mcp", "add", spec.name, "--url", spec.url]);
        if (added.code === 0) return { ok: true, detail: "", clientUnusable: false };

        debugLog(`${this.label} registration sign-in failed`, { code: added.code, stderr: added.stderr });
        return {
            ok: false,
            detail: describeSignInFailure(added, this.label),
            clientUnusable: isClientNotExecutable(added.stderr),
        };
    }

    /** Add (or overwrite) the server, with the token read from an env var by name. */
    private async addServer(spec: McpServerSpec, apiToken: string | undefined): Promise<void> {
        const add = ["mcp", "add", spec.name, "--url", spec.url];
        if (apiToken != null) add.push("--bearer-token-env-var", CODEX_BEARER_TOKEN_ENV);

        const added = await this.runCommand(add);
        if (added.code !== 0) {
            throw new Error(
                `Could not register the ${spec.name} MCP server with ${this.label}: ` +
                    `${describeCommandFailure(added, this.label)}`,
            );
        }
    }
}

/** Every launcher this CLI knows how to build. */
export function buildAllLaunchers(opts: LauncherOptions): AgentLauncher[] {
    return [new ClaudeLauncher(opts), new CodexLauncher(opts)];
}

/**
 * Probe PATH and pick the launcher to hand off to, or undefined when nothing is
 * installed - the one case a caller cannot resolve, and the only one this reports.
 *
 * Zero available -> undefined (the caller decides: manual fallback interactively,
 * hard error otherwise); exactly one -> use it, announced rather than offered as a
 * choice of one; several -> prompt when there is someone to prompt, and take the
 * first when there is not. A preset id (from `--agent`) short-circuits detection
 * when that agent is available.
 */
export async function selectLauncher(
    launchers: AgentLauncher[],
    presetId?: string,
    interactive = true,
): Promise<AgentLauncher | undefined> {
    const availability = await Promise.all(launchers.map((l) => l.isAvailable()));
    const available = launchers.filter((_, i) => availability[i]);
    debugLog("Detected available agents", { available: available.map((l) => l.id), presetId, interactive });

    // `--agent` first, then whatever was picked last time. A flag is this run's
    // instruction and a remembered choice is a standing one, so the flag wins - and
    // neither is trusted to still be installed, which is why both fall through.
    const remembered = presetId ?? (await readPreferences()).agentId;
    if (remembered != null) {
        const preset = available.find((l) => l.id === remembered);
        if (preset != null) {
            if (presetId == null) p.log.info(`Using ${preset.label} - the agent you picked last time.`);
            return preset;
        }
        // Only complain about a flag. A remembered agent that is no longer installed
        // is not a mistake anyone made; it just falls through to the picker.
        if (presetId != null) p.log.warn(`Requested agent "${presetId}" is not installed or not supported.`);
    }

    if (available.length === 0) return undefined;

    if (available.length === 1) {
        const only = available[0]!;
        p.log.info(`Found ${only.label} - will use it for the integration.`);
        return only;
    }

    // Several installed and nobody to ask. Take the first rather than give up: the
    // preview environment is the most valuable thing this run does, and headless is
    // exactly where there is nobody to answer a prompt - refusing here skips that
    // work and leaves the rest of the run planning tests against an app with nowhere
    // to deploy. Which agent does the job barely matters; not doing it does.
    if (!interactive) {
        const first = available[0]!;
        p.log.warn(
            `Several coding agents are installed and there is nobody to ask - using ${first.label}. ` +
                `Pass --agent to choose.`,
        );
        return first;
    }

    const selected = await p.select({
        message: "Which agent should implement the integration?",
        options: available.map((l) => ({ value: l.id, label: l.label })),
    });
    if (p.isCancel(selected)) throw new Error("Agent selection cancelled");

    // Remembered only here, where someone actually chose. The single-installed case
    // above and the headless first-pick are decisions the CLI made on their behalf,
    // and storing one would answer a question they were never asked - wrongly, the
    // moment they install a second agent.
    await updatePreferences({ agentId: selected });
    return available.find((l) => l.id === selected);
}

/** Validate a raw `--permission-mode` flag value, returning undefined if unset/invalid. */
export function parsePermissionMode(value?: string): PermissionMode | undefined {
    if (value === "default" || value === "acceptEdits" || value === "bypassPermissions") return value;
    return undefined;
}

/**
 * Why one of a client's own subcommands failed, in terms of the thing that is actually
 * wrong. A shell that cannot run the binary is a broken installation, not a rejected
 * registration, and saying so is the difference between checking your PATH and hunting
 * a server that was never the problem.
 */
function describeCommandFailure(result: CommandResult, label: string): string {
    return explainFailureReason(firstLine(result.stderr) || firstLine(result.stdout) || "unknown error", label);
}

/** Whether output means the client's binary could not be executed at all. */
function isClientNotExecutable(output: string): boolean {
    return CLIENT_NOT_EXECUTABLE_PATTERNS.some((pattern) => pattern.test(output));
}

/** Restate a raw failure reason as the thing that is actually wrong. */
function explainFailureReason(reason: string, label: string): string {
    if (!isClientNotExecutable(reason)) return reason;
    return `${label} is on your PATH but could not be run (${reason}). ${remedyFor(reason)}`;
}

/**
 * What to do about a binary that would not run, which is not one answer. A missing or
 * broken install is repaired by reinstalling; a refused one is a policy decision on the
 * machine, and reinstalling only produces the same refusal again.
 */
function remedyFor(reason: string): string {
    if (EXECUTION_REFUSED_PATTERNS.some((pattern) => pattern.test(reason))) {
        return (
            "Your system refused to execute it - check antivirus, endpoint security, or an execution " +
            "policy that blocks it, then run again."
        );
    }
    return "Reinstall it, then run again.";
}

/**
 * Why a sign-in failed, for a message the next person can act on. The client writes
 * its own diagnosis to stderr and exits; without quoting it back, an operator reading
 * telemetry sees only "exit 1" and has nothing to go on.
 */
function describeSignInFailure(login: AttachedResult, label: string): string {
    const reason = firstLine(login.stderr);
    const code = login.code ?? "unknown";
    return reason.length > 0 ? ` (exit ${code}: ${explainFailureReason(reason, label)})` : ` (exit ${code})`;
}

/** Narrow parsed JSON to a plain object before indexing into it. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First non-empty line of a command's output, for quoting back in an error. */
function firstLine(output: string): string {
    return (
        output
            .split("\n")
            .find((line) => line.trim().length > 0)
            ?.trim() ?? ""
    );
}
