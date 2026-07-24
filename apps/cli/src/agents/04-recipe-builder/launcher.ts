import type { StdioOptions } from "node:child_process";
import { dirname } from "node:path";
import spawn from "cross-spawn";
import which from "which";
import { debugLog } from "../../core/debug";
import * as p from "../../ui/prompts";
import { readCompletion } from "./completion";

/** How often to check for the completion marker while the agent runs. */
const MARKER_POLL_MS = 2000;
/** Marker seen -> let the agent finish streaming its summary before reclaiming. */
const MARKER_EXIT_GRACE_MS = 30_000;
/** SIGTERM ignored -> force-kill after this long. */
const KILL_ESCALATION_MS = 10_000;

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

/**
 * The one injection seam for the handoff. A launcher knows how to detect its
 * agent on the machine and how to run it, attached to the terminal, over a
 * rendered prompt file. Codex (and other agents) slot in later by implementing
 * this interface; the handoff flow never changes.
 */
export interface AgentLauncher {
    /** Stable id persisted in state and matched by the `--agent` flag (e.g. "claude"). */
    readonly id: string;
    /** Human label for prompts and announcements (e.g. "Claude Code"). */
    readonly label: string;
    /** Whether the agent's binary is on PATH. */
    isAvailable(): Promise<boolean>;
    /**
     * Run the agent over the rendered prompt file, inheriting the env the CLI spawns
     * it with (so the canonical shared secret flows through to the app). When
     * `interactive`, it attaches this process's stdio so the developer watches and
     * drives it (and the agent can surface its own login); otherwise it runs headless
     * and autonomous (`-p`), its output piped to the CLI's stdout/stderr. Resolves
     * with the agent's exit code once it exits.
     */
    launch(promptFile: string, permissionMode: PermissionMode, interactive: boolean): Promise<number | undefined>;
}

export interface LauncherOptions {
    /** Directory the agent runs in - the developer's repo. */
    cwd: string;
    /** Env the agent (and any app it boots) inherits, including AUTONOMA_SHARED_SECRET. */
    env: NodeJS.ProcessEnv;
}

const CLAUDE_ID = "claude";
const CODEX_ID = "codex";

/** Points the agent at the rendered prompt file it must read and follow. */
function launchMessage(promptFile: string): string {
    return (
        `Read the file ${promptFile} and follow its instructions exactly to integrate ` +
        `Autonoma into this application. It is your complete spec. Do not stop until every ` +
        `item in it is done and you have written the completion marker it describes.`
    );
}

/**
 * Shared launcher machinery: detect the binary on PATH, then spawn it over the
 * rendered prompt file and manage the terminal handover. Every agent's `launch`
 * is identical except for its argv, so the only thing a concrete launcher must
 * supply is `buildArgs` (plus its id/label/binary). This is where "argument
 * parsing" lives - each agent maps the shared `PermissionMode` onto its own CLI
 * flags in one method, and the run/watch/reclaim flow never varies.
 */
export abstract class BaseLauncher implements AgentLauncher {
    abstract readonly id: string;
    abstract readonly label: string;
    /** The binary to probe on PATH and spawn. */
    protected abstract readonly command: string;

    constructor(protected readonly opts: LauncherOptions) {}

    /**
     * Translate the run into this agent's argv. `message` points the agent at the
     * rendered prompt file; `interactive` selects the attached-TTY vs headless
     * invocation (which differ per agent, e.g. Claude's `-p`, Codex's `exec`).
     */
    abstract buildArgs(message: string, permissionMode: PermissionMode, interactive: boolean): string[];

    async isAvailable(): Promise<boolean> {
        const resolved = await which(this.command, { nothrow: true });
        debugLog("Probed for agent on PATH", { command: this.command, found: resolved != null });
        return resolved != null;
    }

    launch(promptFile: string, permissionMode: PermissionMode, interactive: boolean): Promise<number | undefined> {
        debugLog(`Launching ${this.label}`, { promptFile, permissionMode, interactive });
        const args = this.buildArgs(launchMessage(promptFile), permissionMode, interactive);
        // Interactive: attach the terminal so the developer watches/steers and the
        // agent can surface its login. Headless: it runs autonomously to completion,
        // output piped to our stdout/stderr for the logs.
        const stdio: StdioOptions = interactive ? "inherit" : ["ignore", "inherit", "inherit"];

        return new Promise<number | undefined>((resolve) => {
            // env carries the canonical shared secret through to the app and the `sdk` calls.
            const proc = spawn(this.command, args, {
                cwd: this.opts.cwd,
                env: this.opts.env,
                stdio,
            });
            // An interactive session never exits on its own - it sits open after the
            // final message. The completion marker is the real "done" signal, so watch
            // for it and reclaim the terminal. Headless runs exit on their own; no watcher.
            const stopWatching = interactive ? watchForCompletion(dirname(promptFile), proc) : () => {};
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
}

/** Claude Code launcher. Authentication is Claude's own concern - it surfaces its
 *  login flow live in the attached terminal. */
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
}

/** Codex CLI launcher. Authentication is Codex's own concern - it surfaces its
 *  login flow live in the attached terminal. */
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
}

export interface CompletionWatchTiming {
    pollMs: number;
    graceMs: number;
    killMs: number;
}

const DEFAULT_WATCH_TIMING: CompletionWatchTiming = {
    pollMs: MARKER_POLL_MS,
    graceMs: MARKER_EXIT_GRACE_MS,
    killMs: KILL_ESCALATION_MS,
};

/**
 * Poll for the completion marker while the interactive agent runs; once it
 * appears, give the agent a beat to finish streaming its summary, then
 * terminate it so control returns to the planner. Returns a cleanup fn.
 */
export function watchForCompletion(
    outputDir: string,
    proc: { kill(signal: NodeJS.Signals): boolean },
    timing: CompletionWatchTiming = DEFAULT_WATCH_TIMING,
): () => void {
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const poll = setInterval(() => {
        void readCompletion(outputDir).then((complete) => {
            if (!complete || graceTimer != null) return;
            debugLog("Completion marker detected while the agent runs; scheduling terminal reclaim");
            clearInterval(poll);
            graceTimer = setTimeout(() => {
                debugLog("Reclaiming the terminal from the interactive agent (SIGTERM)");
                proc.kill("SIGTERM");
                killTimer = setTimeout(() => {
                    debugLog("Agent ignored SIGTERM; escalating to SIGKILL");
                    proc.kill("SIGKILL");
                }, timing.killMs);
            }, timing.graceMs);
        });
    }, timing.pollMs);

    return () => {
        clearInterval(poll);
        if (graceTimer != null) clearTimeout(graceTimer);
        if (killTimer != null) clearTimeout(killTimer);
    };
}

/** Every launcher this CLI knows how to build. */
export function buildAllLaunchers(opts: LauncherOptions): AgentLauncher[] {
    return [new ClaudeLauncher(opts), new CodexLauncher(opts)];
}

/**
 * Probe PATH and pick the launcher to hand off to. Zero available -> undefined
 * (the caller decides: manual fallback interactively, hard error otherwise);
 * exactly one -> use it (announce, don't prompt for a choice of one); multiple ->
 * prompt to pick when interactive, else undefined (can't disambiguate headlessly -
 * name one with `--agent`). A preset id (from `--agent`) short-circuits detection
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

    // Multiple agents and no usable preset: can't prompt headlessly.
    if (!interactive) return undefined;

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
