import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { tool } from "ai";
import { z } from "zod";
import type { AppConfig } from "../../config";
import { runAgent, buildDefaultStepLogger, formatRetryGuidance, type AgentResult } from "../../core/agent";
import { type ProjectContext, formatContext } from "../../core/context";
import { debugLog } from "../../core/debug";
import { getModel } from "../../core/model";
import { parseEntityNames } from "../../core/parse-entity-audit";
import { buildCodebaseTools } from "../../tools";
import { buildAskUserTool } from "../../tools/ask-user";
import { SCENARIO_DESIGN_PROMPT } from "./prompt";
import { validateScenarioIsConcrete } from "./scenario-table";

export interface ScenarioRecipeInput {
    projectRoot: string;
    outputDir: string;
    modelId?: string;
    config: AppConfig;
    projectContext?: ProjectContext;
    nonInteractive?: boolean;
    retryGuidance?: string;
    /** Optional backend/data-layer scope hint from the project map (appended to the prompt). */
    scopeHint?: string;
}

export function buildFinishTool(
    requiredEntities: string[],
    outputDir: string,
    onFinish: (result: AgentResult) => void,
) {
    return tool({
        description:
            "Call when scenario design is complete and scenarios.md is written. " +
            "BLOCKED if any required entities are missing from the scenario.",
        inputSchema: z.object({
            summary: z.string().describe("Summary of the scenario"),
            entityCount: z.number().describe("Number of entity types in the scenario"),
            artifacts: z.array(z.string()).describe("Files written"),
        }),
        execute: async (input) => {
            // These checks return an error string back to the agent so it can fix the
            // scenario and call finish again - they must never throw / fail fatally.
            let content: string;
            try {
                content = await readFile(join(outputDir, "scenarios.md"), "utf-8");
            } catch {
                return { error: "Cannot finish: scenarios.md not found. Write it first." };
            }

            if (requiredEntities.length > 0) {
                const missing = requiredEntities.filter((e) => !content.includes(e));
                if (missing.length > 0) {
                    return {
                        error:
                            `Cannot finish: ${missing.length} entities from the entity audit are missing from scenarios.md.\n` +
                            `Add these entities to the scenario before calling finish:\n` +
                            missing.map((e) => `  - ${e}`).join("\n"),
                    };
                }
            }

            const concretenessErrors = validateScenarioIsConcrete(content);
            if (concretenessErrors.length > 0) {
                return {
                    error:
                        `Cannot finish: scenario data must be fully concrete - no variables, tokens, or placeholders.\n` +
                        `Fix these before calling finish:\n` +
                        concretenessErrors.map((e) => `  - ${e}`).join("\n"),
                };
            }

            onFinish({
                success: true,
                artifacts: input.artifacts,
                summary: input.summary,
            });
            return { success: true };
        },
    });
}

export async function runScenarioRecipe(input: ScenarioRecipeInput): Promise<AgentResult> {
    const model = getModel(input.modelId);

    let result: AgentResult | undefined;

    const { logger, onStepFinish } = buildDefaultStepLogger("scenario", 40);

    const scopeBlock = input.scopeHint != null ? `\n${input.scopeHint}\n` : "";
    const contextBlock =
        (input.projectContext ? "\n" + formatContext(input.projectContext) + "\n" : "") +
        scopeBlock +
        formatRetryGuidance(input.retryGuidance);

    const requiredEntities = await parseEntityNames(input.outputDir);

    const entityListBlock =
        requiredEntities.length > 0
            ? `\n## Required entities (${requiredEntities.length} total - ALL must appear in the scenario)\n\n${requiredEntities.map((e) => `- ${e}`).join("\n")}\n\nThe finish tool will REJECT your output if any of these are missing.\n`
            : "";

    const prompt = `Read the entity audit and knowledge base from the output directory, then design a single "standard" scenario.
${contextBlock}${entityListBlock}
IMPORTANT: Use read_output to read files from the output directory (AUTONOMA.md, entity-audit.md).
Use write_file with just the filename (e.g. "scenarios.md", NOT "autonoma/scenarios.md") - write_file already targets the output directory.

The scenario should:
1. Cover ALL ${requiredEntities.length || ""} entity types from the entity audit - no exceptions
2. Use realistic data volumes (not just 1 of each)
3. Cover all enum values (at least one record per value)

When done, call finish.`;

    const agentConfig = {
        id: "scenario-recipe",
        systemPrompt: SCENARIO_DESIGN_PROMPT,
        model,
        maxSteps: 40,
        tools: async (heartbeat: () => void) => {
            const tools = await buildCodebaseTools(model, input.projectRoot, input.outputDir, heartbeat);
            return {
                ...tools,
                ask_user: buildAskUserTool(),
                finish: buildFinishTool(requiredEntities, input.outputDir, (r) => {
                    result = r;
                }),
            };
        },
        onStepFinish,
    };

    await runAgent(agentConfig, prompt, () => result);
    logger.summary();

    // Output review happens live in the TUI - the run no longer stops to ask.
    const reviewed = result;

    if (!reviewed) {
        const scenariosPath = join(input.outputDir, "scenarios.md");
        try {
            await readFile(scenariosPath, "utf-8");
            return {
                success: true,
                artifacts: ["scenarios.md"],
                summary: "Scenarios generated (finish tool may not have captured the result, but scenarios.md exists).",
            };
        } catch (err) {
            debugLog("scenarios.md not readable; falling back to reviewed result", { err });
        }
    }

    return (
        reviewed ?? {
            success: false,
            artifacts: [],
            summary: "Scenario agent stopped without producing scenarios.md",
        }
    );
}

export async function feedbackToScenario(input: ScenarioRecipeInput, feedback: string): Promise<AgentResult> {
    const model = getModel(input.modelId);
    let result: AgentResult | undefined;

    const { logger, onStepFinish } = buildDefaultStepLogger("scenario-feedback", 30);

    const requiredEntities = await parseEntityNames(input.outputDir);

    const agentConfig = {
        id: "scenario-recipe",
        systemPrompt: SCENARIO_DESIGN_PROMPT,
        model,
        maxSteps: 30,
        tools: async (heartbeat: () => void) => {
            const tools = await buildCodebaseTools(model, input.projectRoot, input.outputDir, heartbeat);
            return {
                ...tools,
                ask_user: buildAskUserTool(),
                finish: buildFinishTool(requiredEntities, input.outputDir, (r) => {
                    result = r;
                }),
            };
        },
        onStepFinish,
    };

    await runAgent(agentConfig, feedback, () => result);
    logger.summary();

    return result ?? { success: false, artifacts: [], summary: "Scenario feedback did not produce a result" };
}
