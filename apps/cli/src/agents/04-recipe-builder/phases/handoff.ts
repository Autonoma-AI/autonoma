import { rm } from "node:fs/promises";
import { join } from "node:path";
import { debugLog } from "../../../core/debug";
import { suspend, resume } from "../../../core/interrupt";
import { notify } from "../../../core/notify";
import * as p from "../../../ui/prompts";
import { COMPLETION_MARKER_FILE, readCompletion } from "../completion";
import { INTEGRATION_PROMPT_FILE, writeIntegrationPrompt } from "../integration-prompt";
import type { AgentLauncher, PermissionMode } from "../launcher";
import { DEFAULT_PERMISSION_MODE, selectLauncher, selectPermissionMode } from "../launcher";
import { loadRecipe, RECIPE_FILE } from "../recipe";
import type { RecipeBuilderState } from "../state";
import { saveRecipeState } from "../state";

/** Total interactive launches allowed: the first, plus one re-launch to finish. */
export const MAX_LAUNCH_ATTEMPTS = 2;

/** Breathing room before the terminal switches to the coding agent. */
const HANDOFF_COUNTDOWN_SECONDS = 10;

export interface HandoffDeps {
    /** Launchers to detect/select over. Injected in tests; built from the repo in prod. */
    launchers: AgentLauncher[];
    /** Preset agent id from `--agent`. */
    presetAgentId?: string;
    /** Preset permission mode from `--permission-mode`. */
    presetPermissionMode?: PermissionMode;
    /** How the agent invokes the CLI's endpoint tool: `<cliCommand> sdk up|down|discover`. */
    cliCommand: string;
    /** Interactive run: prompt + attach the agent to the TTY. Otherwise run headless,
     *  autonomous, no prompts, and hard-error (not manual-fallback) when no agent exists. */
    interactive: boolean;
}

/** What a phase run tells the orchestrator to do next. */
export type PhaseOutcome =
    | { kind: "advance" }
    | { kind: "pause"; summary: string }
    | { kind: "handback"; summary: string };

/**
 * Hand the whole integration to the developer's own coding agent (e.g. Claude Code).
 * When an agent is available it just launches - no "do you want to?" prompt; the
 * whole point of this step is that the agent implements the integration. Interactive
 * runs pick an autonomy level and attach it to the terminal. Only a genuinely missing
 * agent drops to the manual fallback (a note, not a question): interactively it prints
 * the instructions to run by hand; headless it hard-errors.
 */
export async function runHandoffPhase(
    state: RecipeBuilderState,
    deps: HandoffDeps,
    outputDir: string,
): Promise<PhaseOutcome> {
    const recipePath = state.recipePath ?? join(outputDir, RECIPE_FILE);
    state.recipePath = recipePath;

    const launcher = await selectLauncher(deps.launchers, state.agentId ?? deps.presetAgentId, deps.interactive);
    if (launcher == null) {
        // Non-interactive requires an agent - there is no manual fallback without a TTY.
        if (!deps.interactive) {
            return {
                kind: "handback",
                summary:
                    "--non-interactive SDK implementation requires an installed, supported coding agent, but none was resolved on your PATH (name one with --agent if more than one is present). Install one, or run interactively.",
            };
        }
        return manualFallback(outputDir, recipePath, deps.cliCommand, "No supported agent found on your PATH.");
    }

    const permissionMode = deps.interactive
        ? await selectPermissionMode(state.permissionMode ?? deps.presetPermissionMode)
        : (state.permissionMode ?? deps.presetPermissionMode ?? DEFAULT_PERMISSION_MODE);
    state.agentId = launcher.id;
    state.permissionMode = permissionMode;
    await saveRecipeState(outputDir, state);

    await launchAgent(launcher, permissionMode, {
        outputDir,
        recipePath,
        cliCommand: deps.cliCommand,
        interactive: deps.interactive,
    });
    state.launchAttempts = (state.launchAttempts ?? 0) + 1;
    await saveRecipeState(outputDir, state);

    // launchAgent awaited the coding agent's exit, so control is back here; the
    // completion phase (next) decides success from the marker + recipe, not the exit code.
    return { kind: "advance" };
}

/**
 * CLI-side orchestration - the coding agent is a separate, already-exited process and
 * never runs this code. "Done" is purely file-based: the completion marker the agent
 * wrote plus a present recipe.json (the agent owns all validation - per entity: up ->
 * DB -> down -> DB). We NEVER ask the user whether they implemented it.
 *
 * If it isn't done and a supported agent is available, (re-)launch it to finish, up to
 * MAX_LAUNCH_ATTEMPTS. This also self-heals a run left mid-handoff - e.g. a prior
 * session whose state advanced to this phase without an agent ever launching. When no
 * agent is available or the attempts are spent, control hands back with instructions.
 */
export async function runCompletionPhase(
    state: RecipeBuilderState,
    deps: HandoffDeps,
    outputDir: string,
): Promise<PhaseOutcome> {
    const recipePath = state.recipePath ?? join(outputDir, RECIPE_FILE);

    while (true) {
        const complete = await readCompletion(outputDir);
        const recipeReady = (await loadRecipe(outputDir)) != null;

        if (complete && recipeReady) {
            p.log.success("The agent reported the integration complete and validated.");
            return { kind: "advance" };
        }

        const failure = !recipeReady
            ? "No completed recipe.json was produced, so there is nothing validated to submit."
            : "The agent exited without marking the integration complete (see its IMPLEMENTATION.md for what's left).";

        const launcher = await selectLauncher(deps.launchers, state.agentId ?? deps.presetAgentId, deps.interactive);
        if (launcher != null && (state.launchAttempts ?? 0) < MAX_LAUNCH_ATTEMPTS) {
            p.log.warn("The integration isn't complete yet. Launching the agent to finish it...");
            state.agentId = launcher.id;
            state.priorFailure = failure;
            await saveRecipeState(outputDir, state);

            await launchAgent(launcher, state.permissionMode ?? "bypassPermissions", {
                outputDir,
                recipePath,
                cliCommand: deps.cliCommand,
                interactive: deps.interactive,
                priorFailure: failure,
            });
            state.launchAttempts = (state.launchAttempts ?? 0) + 1;
            await saveRecipeState(outputDir, state);
            continue;
        }

        return { kind: "handback", summary: handbackSummary(failure, outputDir) };
    }
}

function handbackSummary(failure: string, outputDir: string): string {
    return (
        `${failure}\n\n` +
        `Finish the integration (see the prompt at ${join(outputDir, INTEGRATION_PROMPT_FILE)}), ` +
        `then re-run with --resume.`
    );
}

interface LaunchTarget {
    outputDir: string;
    recipePath: string;
    cliCommand: string;
    interactive: boolean;
    priorFailure?: string;
}

/** Render the prompt file and run the agent with the terminal handed over to it. */
async function launchAgent(
    launcher: AgentLauncher,
    permissionMode: PermissionMode,
    target: LaunchTarget,
): Promise<void> {
    const promptFile = await writeIntegrationPrompt({
        outputDir: target.outputDir,
        recipePath: target.recipePath,
        cliCommand: target.cliCommand,
        priorFailure: target.priorFailure,
    });

    // A stale marker from an earlier session would make the completion watcher
    // reclaim the terminal seconds after launch - the agent must write it fresh.
    await rm(join(target.outputDir, COMPLETION_MARKER_FILE), { force: true }).catch((err) => {
        debugLog("Could not clear a stale completion marker", { err });
    });

    p.log.info(`Launching ${launcher.label}. It will implement the integration - watch and steer it as it works.`);
    notify("Autonoma", "Handing off to your local agent");

    if (target.interactive) {
        await p.countdown({
            title: `Handing off to ${launcher.label}`,
            lines: [
                `Your terminal is about to switch to ${launcher.label}. It will implement the ` +
                    `Autonoma SDK integration inside your repo: install the SDK, wire the endpoint, ` +
                    `and write a real factory for every entity in the audit, validating each one ` +
                    `against your locally running app.`,
                `This dashboard disappears while it works - that's expected. Watch and steer it ` +
                    `like any ${launcher.label} session; this usually takes a while.`,
                `When it finishes and exits, you come straight back here and the planner continues ` +
                    `where it left off: submitting the validated recipe, then generating your test suite.`,
            ],
            seconds: HANDOFF_COUNTDOWN_SECONDS,
        });
    }

    // Hand the terminal (SIGINT + raw mode) to the agent, then take it back.
    suspend();
    try {
        const exitCode = await launcher.launch(promptFile, permissionMode, target.interactive);
        p.log.info(`${launcher.label} exited (code ${exitCode ?? "unknown"}). Back to the planner.`);
    } finally {
        resume();
    }
}

/**
 * Manual fallback: no automated run. Point the developer at the rendered prompt so
 * they can implement it in whatever assistant they have, then pause so a later
 * `--resume` confirms completion and continues to test generation.
 */
async function manualFallback(
    outputDir: string,
    recipePath: string,
    cliCommand: string,
    why: string,
): Promise<PhaseOutcome> {
    const promptFile = await writeIntegrationPrompt({ outputDir, recipePath, cliCommand });
    p.note(
        `${why}\n\n` +
            `The full integration instructions have been written to:\n  ${promptFile}\n\n` +
            `Implement them with your AI assistant (or by hand), get your app running locally, then\n` +
            `re-run with --resume. The CLI will continue to test generation.`,
        "Implement the integration yourself",
    );
    return { kind: "pause", summary: "Integration handed off for manual implementation - resume when it's ready." };
}
