import type { StdioOptions } from "node:child_process";
import spawn from "cross-spawn";
import which from "which";
import * as p from "../ui/prompts";
import { debugLog } from "./debug";

/** Ceiling on a client's own `mcp` subcommands, which talk to the server to health-check it. */
const MCP_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Set on the environment of every coding agent this CLI spawns, and refused at spawn
 * time when it is already present. Without it a loop is trivially reachable: an agent
 * runs the CLI, the CLI spawns an agent, that agent runs the CLI. Each turn of the
 * loop is a long, expensive run, so the guard is a hard refusal rather than a warning.
 */
export const SPAWNED_BY_PLANNER_ENV = "AUTONOMA_PLANNER_SPAWNED_AGENT";

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
     * Bearer token for headless authorization. When absent, the client authorizes
     * interactively through a browser sign-in, which needs a terminal - so this is
     * required for any run that does not have one.
     */
    apiToken?: string;
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
    /** Run the agent, resolving with its exit code once it exits. */
    launch(request: LaunchRequest): Promise<number | undefined>;
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

/**
 * Whether this process is itself running inside an agent the CLI spawned. Callers
 * check it before handing off, so the refusal is a clear message rather than a
 * surprise several minutes into a nested run.
 */
export function isSpawnedByPlanner(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[SPAWNED_BY_PLANNER_ENV] != null && env[SPAWNED_BY_PLANNER_ENV] !== "";
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

    async launch(request: LaunchRequest): Promise<number | undefined> {
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

        return new Promise<number | undefined>((resolve) => {
            const proc = spawn(this.command, args, {
                cwd: this.opts.cwd,
                env: this.spawnEnv(request.env),
                stdio,
            });
            const stopWatching = request.watch?.(proc) ?? (() => {});
            proc.on("error", (err: Error) => {
                debugLog(`${this.label} failed to spawn`, { err });
                p.log.error(`Couldn't launch ${this.label}: ${err.message}`);
                stopWatching();
                resolve(undefined);
            });
            proc.on("close", (code) => {
                debugLog(`${this.label} exited`, { code });
                stopWatching();
                resolve(code ?? undefined);
            });
        });
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
            const proc = spawn(this.command, args, {
                cwd: this.opts.cwd,
                env: this.opts.env,
                stdio: ["ignore", "pipe", "pipe"],
                timeout: MCP_COMMAND_TIMEOUT_MS,
            });
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
     * Refused outright without a terminal. The flow prints a URL, opens a browser and
     * blocks on the callback, so a run with nobody at the keyboard would not fail - it
     * would hang, indefinitely, on a prompt nobody can see. A run without a terminal
     * is meant to have passed an API token instead, and the error says so rather than
     * describing the sign-in that could not happen.
     */
    protected async signIn(serverName: string): Promise<void> {
        if (process.stdin.isTTY !== true) {
            throw new Error(
                `Cannot sign ${this.label} in to the ${serverName} MCP server without a terminal: that flow opens ` +
                    `a browser and waits for it. Set AUTONOMA_API_TOKEN so the run authorizes with an API key instead.`,
            );
        }

        p.log.info(`Authorizing ${this.label} with Autonoma - approve it in the browser that opens.`);
        const login = await this.runAttached(["mcp", "login", serverName]);
        if (login !== 0) {
            throw new Error(
                `${this.label} could not sign in to the ${serverName} MCP server (exit ${login ?? "unknown"}).`,
            );
        }
    }

    /**
     * Run a subcommand that hands the terminal over - an interactive OAuth sign-in.
     * The client prints a URL, opens a browser and waits on the callback, so it needs
     * this process's stdio rather than pipes.
     */
    protected runAttached(args: string[]): Promise<number | undefined> {
        debugLog(`Running ${this.command} ${args.join(" ")} attached`);
        return new Promise<number | undefined>((resolve) => {
            const proc = spawn(this.command, args, { cwd: this.opts.cwd, env: this.opts.env, stdio: "inherit" });
            proc.on("error", (err: Error) => {
                debugLog(`${this.command} ${args[0] ?? ""} failed to spawn`, { err });
                resolve(undefined);
            });
            proc.on("close", (code) => resolve(code ?? undefined));
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
        // attaches the REPL. Both take the same `--permission-mode`.
        return interactive
            ? ["--permission-mode", permissionMode, message]
            : ["-p", message, "--permission-mode", permissionMode, "--verbose"];
    }

    /**
     * `--scope user` and not the default (`local`): the default binds the server to the
     * directory the command ran in. The planner can be invoked from anywhere in a repo,
     * and a server registered against the wrong directory looks exactly like one that
     * was never authorized - the agent simply has no Autonoma tools.
     *
     * With a token the header goes into Claude's own config and there is nothing to
     * sign in to. Without one, the browser sign-in runs attached to the terminal.
     */
    async registerMcpServer(spec: McpServerSpec): Promise<McpRegistration> {
        const add = ["mcp", "add", "--transport", "http", "--scope", "user", spec.name, spec.url];
        // The token goes in argv, where `ps` can read it for the length of this call,
        // and is then stored in plaintext in Claude's user config. Claude has no
        // env-var-by-name option for headers the way Codex does (`-e/--env` sets a
        // stdio server's subprocess env; `--client-secret` is the OAuth client secret),
        // so there is no alternative here. It is also not new exposure: this is the
        // same AUTONOMA_API_TOKEN the user pasted to start the planner, already in that
        // process's own argv for the whole run, which is far longer than this call.
        if (spec.apiToken != null) add.push("--header", `Authorization: Bearer ${spec.apiToken}`);

        // `mcp add` exits non-zero when the server is already registered, which is the
        // normal case on every run after the first. `get` is what actually answers
        // whether the client has it, so the add's exit code is a hint, not a verdict.
        //
        // But an existing registration is only useful if it points where this run does.
        // `mcp add` will not update one, so a registration left over from another
        // environment would be reused in silence and the agent would work against the
        // wrong Autonoma. Replace it rather than inherit it.
        const existing = await this.runCommand(["mcp", "get", spec.name]);
        if (existing.code === 0 && !existing.stdout.includes(spec.url)) {
            debugLog("Replacing an MCP registration that points elsewhere", { server: spec.name, url: spec.url });
            await this.runCommand(["mcp", "remove", spec.name, "-s", "user"]);
        }

        await this.runCommand(add);
        const registered = await this.runCommand(["mcp", "get", spec.name]);
        if (registered.code !== 0) {
            throw new Error(
                `Could not register the ${spec.name} MCP server with ${this.label}: ` +
                    `${firstLine(registered.stderr) || firstLine(registered.stdout) || "unknown error"}`,
            );
        }

        if (spec.apiToken == null && !registered.stdout.includes(CLAUDE_CONNECTED_MARKER)) {
            await this.signIn(spec.name);
        }

        return { env: {} };
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
        const add = ["mcp", "add", spec.name, "--url", spec.url];
        if (spec.apiToken != null) add.push("--bearer-token-env-var", CODEX_BEARER_TOKEN_ENV);

        const added = await this.runCommand(add);
        if (added.code !== 0) {
            throw new Error(
                `Could not register the ${spec.name} MCP server with ${this.label}: ` +
                    `${firstLine(added.stderr) || firstLine(added.stdout) || "unknown error"}`,
            );
        }

        if (spec.apiToken == null) {
            await this.signIn(spec.name);
            return { env: {} };
        }

        return { env: { [CODEX_BEARER_TOKEN_ENV]: spec.apiToken } };
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

    if (presetId != null) {
        const preset = available.find((l) => l.id === presetId);
        if (preset != null) return preset;
        p.log.warn(`Requested agent "${presetId}" is not installed or not supported.`);
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
    return available.find((l) => l.id === selected);
}

/**
 * Resolve the permission mode: a preset from the `--permission-mode` flag wins;
 * otherwise offer a select prompt defaulting to fully autonomous.
 */
export async function selectPermissionMode(preset?: PermissionMode): Promise<PermissionMode> {
    if (preset != null) return preset;

    const selected = await p.select<PermissionMode>({
        message: "How much autonomy should the agent have?",
        options: [
            { value: "bypassPermissions", label: PERMISSION_MODE_LABELS.bypassPermissions },
            { value: "acceptEdits", label: PERMISSION_MODE_LABELS.acceptEdits },
            { value: "default", label: PERMISSION_MODE_LABELS.default },
        ],
        initialValue: DEFAULT_PERMISSION_MODE,
    });
    if (p.isCancel(selected)) throw new Error("Permission mode selection cancelled");
    return selected;
}

/** Validate a raw `--permission-mode` flag value, returning undefined if unset/invalid. */
export function parsePermissionMode(value?: string): PermissionMode | undefined {
    if (value === "default" || value === "acceptEdits" || value === "bypassPermissions") return value;
    return undefined;
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
