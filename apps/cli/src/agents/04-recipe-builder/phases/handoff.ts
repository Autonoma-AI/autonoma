import { join } from "node:path";
import * as p from "@clack/prompts";
import { suspend, resume } from "../../../core/interrupt";
import { notify } from "../../../core/notify";
import { readCompletion } from "../completion";
import { INTEGRATION_PROMPT_FILE, writeIntegrationPrompt } from "../integration-prompt";
import type { AgentLauncher, PermissionMode } from "../launcher";
import { DEFAULT_PERMISSION_MODE, selectLauncher, selectPermissionMode } from "../launcher";
import { loadRecipe, RECIPE_FILE } from "../recipe";
import type { RecipeBuilderState } from "../state";
import { saveRecipeState } from "../state";

/** Total interactive launches allowed: the first, plus one re-launch to finish. */
export const MAX_LAUNCH_ATTEMPTS = 2;

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
 * Interactive: ask to launch (Enter = go), pick an autonomy level, and attach it to
 * the terminal. Headless (--non-interactive): run it autonomously with no prompts and
 * hard-error when no agent is available (no manual fallback without a TTY).
 * Interactively, a missing agent or a decline drops to printing the instructions to
 * run by hand.
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

    if (deps.interactive) {
        const proceed = await p.confirm({
            message: `Implement the SDK integration now with your local ${launcher.label}?`,
            initialValue: true, // Enter = launch
        });
        if (p.isCancel(proceed)) throw new Error("Handoff cancelled");
        if (!proceed) {
            return manualFallback(outputDir, recipePath, deps.cliCommand, `You chose not to launch ${launcher.label}.`);
        }
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
 * never runs this code. Confirm it finished and left a recipe to submit: the agent
 * owns all validation (per entity: up -> DB -> down -> DB), so "done" here is just the
 * completion marker it wrote plus a present recipe.json.
 *
 * The loop is the CLI's bounded re-launch. On the AUTOMATED path (an agent ran) an
 * incomplete session re-launches the agent ONCE, then re-checks. On the MANUAL path
 * (interactive, no agent ran) we ask the developer whether they've implemented it.
 * Either way an unresolved case hands control back with a clear explanation.
 */
export async function runCompletionPhase(
    state: RecipeBuilderState,
    deps: HandoffDeps,
    outputDir: string,
): Promise<PhaseOutcome> {
    const recipePath = state.recipePath ?? join(outputDir, RECIPE_FILE);
    const automated = (state.launchAttempts ?? 0) >= 1;

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

        if (automated) {
            const launcher = await launcherFor(state, deps);
            if (launcher != null && (state.launchAttempts ?? 0) < MAX_LAUNCH_ATTEMPTS) {
                p.log.warn("The integration isn't complete yet. Re-launching the agent once to finish it...");
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

        // Manual path is interactive-only; a non-interactive run can't ask, so it hands back.
        if (!deps.interactive) return { kind: "handback", summary: handbackSummary(failure, outputDir) };

        // No agent ran. If the developer's assistant wrote the marker we would have
        // advanced above; otherwise ask whether they've finished.
        const done = await p.confirm({
            message: "Have you implemented the integration and is the recipe complete?",
            initialValue: true,
        });
        if (p.isCancel(done)) throw new Error("Completion check cancelled");
        if (done && recipeReady) return { kind: "advance" };
        if (done && !recipeReady) {
            p.log.warn(
                `I couldn't find a completed ${RECIPE_FILE} in ${outputDir}. Make sure it's written before you resume.`,
            );
        }
        return { kind: "pause", summary: "Resume when the integration is implemented and the recipe is written." };
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

    p.log.info(`Launching ${launcher.label}. It will implement the integration - watch and steer it as it works.`);
    notify("Autonoma", "Handing off to your local agent");

    // Hand the terminal (SIGINT + raw mode) to the agent, then take it back.
    suspend();
    try {
        const exitCode = await launcher.launch(promptFile, permissionMode, target.interactive);
        p.log.info(`${launcher.label} exited (code ${exitCode ?? "unknown"}). Back to the planner.`);
    } finally {
        resume();
    }
}

/** Rebuild the chosen launcher from persisted state, without re-prompting. */
async function launcherFor(state: RecipeBuilderState, deps: HandoffDeps): Promise<AgentLauncher | undefined> {
    const id = state.agentId;
    if (id == null) return undefined;
    const match = deps.launchers.find((l) => l.id === id);
    if (match == null) return undefined;
    return (await match.isAvailable()) ? match : undefined;
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
