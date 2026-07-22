import { randomBytes } from "node:crypto";
import * as p from "@clack/prompts";
import type { AppConfig } from "../../config";
import type { AgentResult } from "../../core/agent";
import type { ProjectContext } from "../../core/context";
import { readEnv } from "../../env";
import { parseEntityAudit, resolveEntityOrder } from "./entity-order";
import { buildAllLaunchers, type AgentLauncher, type PermissionMode } from "./launcher";
import { runCompletionPhase, runHandoffPhase, type HandoffDeps, type PhaseOutcome } from "./phases/handoff";
import { runSubmit } from "./phases/submit";
import { initialRecipeState, loadRecipeState, saveRecipeState } from "./state";

export interface RecipeBuilderInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    config: AppConfig;
    projectContext?: ProjectContext;
    nonInteractive?: boolean;
    /** User guidance from a pipeline-level retry. Step-04 has its own recovery, so
     *  this is accepted but currently unused. */
    retryGuidance?: string;
    /** Preset agent id from the `--agent` flag. */
    agent?: string;
    /** Preset permission mode from the `--permission-mode` flag. */
    permissionMode?: PermissionMode;
    /** Test seam: inject the AgentLauncher(s) instead of building the real Claude one. */
    launchers?: AgentLauncher[];
    /** Override how the agent invokes this CLI's `sdk` tool (defaults to this process). */
    cliCommand?: string;
}

function generateSharedSecret(): string {
    return randomBytes(32).toString("hex");
}

/** Turn a phase outcome into the AgentResult the pipeline expects, or undefined to continue. */
function outcomeToResult(outcome: PhaseOutcome): AgentResult | undefined {
    if (outcome.kind === "advance") return undefined;
    if (outcome.kind === "pause") {
        return { success: false, paused: true, artifacts: [], summary: outcome.summary };
    }
    return { success: false, artifacts: [], summary: outcome.summary };
}

export async function runRecipeBuilder(input: RecipeBuilderInput): Promise<AgentResult> {
    const { outputDir } = input;

    const state = (await loadRecipeState(outputDir)) ?? initialRecipeState();

    // Canonical shared secret: the app's onboarding secret when present, else a
    // CLI-generated one persisted for the run. It flows CLI -> agent -> app via env
    // inheritance, so the app and the agent's signed `sdk` calls use the same value.
    if (state.sharedSecret == null) {
        state.sharedSecret = input.config.sharedSecret ?? generateSharedSecret();
        await saveRecipeState(outputDir, state);
    }

    const models = await parseEntityAudit(outputDir);

    // Phase 1: resolve a dependency order + seed state. The agent discovers the stack
    // and generates the recipe itself, so this needs no LLM.
    if (state.phase === "tech-detect") {
        state.entityOrder = resolveEntityOrder(models);
        state.entities = {};
        for (const name of state.entityOrder) {
            state.entities[name] = { entityName: name, status: "pending", errorLog: [] };
        }
        state.phase = "handoff";
        await saveRecipeState(outputDir, state);
        p.log.info(`Found ${state.entityOrder.length} entities needing factories.`);
    }

    const handoffDeps = buildHandoffDeps(input, state.sharedSecret);

    // Phase 2: Hand off to the developer's local agent - interactive (attached to the
    // TTY) or, under --non-interactive, headless and autonomous.
    if (state.phase === "handoff") {
        const outcome = await runHandoffPhase(state, handoffDeps, outputDir);
        // Completion is always next: on advance we fall through to it in the same run;
        // on a manual fallback we pause here and a later --resume enters completion.
        state.phase = "completion";
        await saveRecipeState(outputDir, state);
        const result = outcomeToResult(outcome);
        if (result != null) return result;
    }

    // Phase 3: Confirm the agent reported done (with a bounded re-launch to finish).
    if (state.phase === "completion") {
        const outcome = await runCompletionPhase(state, handoffDeps, outputDir);
        if (outcome.kind !== "advance") {
            const result = outcomeToResult(outcome);
            if (result != null) return result;
        }
        state.phase = "submit";
        await saveRecipeState(outputDir, state);
    }

    // Phase 4: Submit the agent-validated recipe.
    if (state.phase === "submit") {
        const env = readEnv();
        const { recipePath, uploaded } = await runSubmit(
            outputDir,
            env.AUTONOMA_API_URL,
            env.AUTONOMA_API_TOKEN,
            env.AUTONOMA_GENERATION_ID,
        );

        const uploadCredentialsPresent =
            env.AUTONOMA_API_URL != null && env.AUTONOMA_API_TOKEN != null && env.AUTONOMA_GENERATION_ID != null;
        if (uploadCredentialsPresent && !uploaded) {
            return {
                success: false,
                artifacts: [recipePath],
                summary: `Recipe was generated but not accepted by Autonoma. The recipe JSON was printed above - re-upload with \`npx @autonoma-ai/planner@latest upload\` (or run again with --resume).`,
            };
        }

        state.phase = "done";
        await saveRecipeState(outputDir, state);

        return {
            success: true,
            artifacts: [recipePath],
            summary: `Recipe builder complete. ${state.entityOrder.length} factories configured.`,
        };
    }

    return { success: true, artifacts: [], summary: "Recipe builder already complete." };
}

/**
 * Assemble the handoff dependencies. The canonical shared secret is placed in the
 * env the agent (and the app it boots, and the `sdk` commands it runs) inherit, and
 * `cliCommand` is how the agent invokes this CLI's endpoint tool.
 */
function buildHandoffDeps(input: RecipeBuilderInput, sharedSecret: string): HandoffDeps {
    const agentEnv: NodeJS.ProcessEnv = { ...process.env, AUTONOMA_SHARED_SECRET: sharedSecret };
    const launchers = input.launchers ?? buildAllLaunchers({ cwd: input.projectRoot, env: agentEnv });
    const cliCommand = input.cliCommand ?? `${process.execPath} ${process.argv[1] ?? ""}`;

    return {
        launchers,
        presetAgentId: input.agent,
        presetPermissionMode: input.permissionMode,
        cliCommand,
        interactive: !input.nonInteractive,
    };
}
