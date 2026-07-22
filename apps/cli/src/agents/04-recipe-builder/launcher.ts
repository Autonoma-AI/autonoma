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

export interface ClaudeLauncherOptions {
    /** Directory the agent runs in - the developer's repo. */
    cwd: string;
    /** Env the agent (and any app it boots) inherits, including AUTONOMA_SHARED_SECRET. */
    env: NodeJS.ProcessEnv;
}

const CLAUDE_ID = "claude";

/** Points the agent at the rendered prompt file it must read and follow. */
function launchMessage(promptFile: string): string {
    return (
        `Read the file ${promptFile} and follow its instructions exactly to integrate ` +
        `Autonoma into this application. It is your complete spec. Do not stop until every ` +
        `item in it is done and you have written the completion marker it describes.`
    );
}

/** Claude Code launcher. Authentication is Claude's own concern - it surfaces its
 *  login flow live in the attached terminal. */
export class ClaudeLauncher implements AgentLauncher {
    readonly id = CLAUDE_ID;
    readonly label = "Claude Code";

    constructor(private readonly opts: ClaudeLauncherOptions) {}

    async isAvailable(): Promise<boolean> {
        const resolved = await which(CLAUDE_ID, { nothrow: true });
        debugLog("Probed for claude on PATH", { found: resolved != null });
        return resolved != null;
    }

    launch(promptFile: string, permissionMode: PermissionMode, interactive: boolean): Promise<number | undefined> {
        debugLog("Launching Claude Code", { promptFile, permissionMode, interactive });
        const message = launchMessage(promptFile);
        // Interactive: attach the terminal so the developer watches/steers and Claude
        // can surface its login. Headless (`-p`): autonomous print mode for
        // --non-interactive runs, with output piped to our stdout/stderr for the logs.
        const args = interactive
            ? ["--permission-mode", permissionMode, message]
            : ["-p", message, "--permission-mode", permissionMode, "--verbose"];
        const stdio: StdioOptions = interactive ? "inherit" : ["ignore", "inherit", "inherit"];

        return new Promise<number | undefined>((resolve) => {
            // env carries the canonical shared secret through to the app and the `sdk` calls.
            const proc = spawn(CLAUDE_ID, args, {
                cwd: this.opts.cwd,
                env: this.opts.env,
                stdio,
            });
            // An interactive session never exits on its own - after the final
            // message it sits at its REPL. The completion marker is the real
            // "done" signal, so watch for it and reclaim the terminal.
            const stopWatching = interactive ? watchForCompletion(dirname(promptFile), proc) : () => {};
            proc.on("error", (err: Error) => {
                debugLog("Claude Code failed to spawn", { err });
                p.log.error(`Couldn't launch Claude Code: ${err.message}`);
                stopWatching();
                resolve(undefined);
            });
            proc.on("close", (code) => {
                debugLog("Claude Code exited", { code });
                stopWatching();
                resolve(code ?? undefined);
            });
        });
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

/** Every launcher this CLI knows how to build. Claude only, for now. */
export function buildAllLaunchers(opts: ClaudeLauncherOptions): AgentLauncher[] {
    return [new ClaudeLauncher(opts)];
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
