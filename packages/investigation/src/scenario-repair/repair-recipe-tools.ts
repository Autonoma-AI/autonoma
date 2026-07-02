import { type Tool, tool } from "ai";
import { z } from "zod";
import {
    createGitDiffTool,
    createGrepCodeTool,
    createPreviewEnvTool,
    createReadCodeTool,
    createRunScriptTool,
} from "../classify/tools";
import { createToolBudget } from "../tool-output";
import type { RepairRecipeDeps } from "./repair-recipe-deps";
import type { DryRunSeed } from "./repair-recipe-deps";
import { validateRecipeGraph } from "./validate-recipe-graph";

/** Validate a candidate create graph locally (structure + resolving refs) - instant, no provisioning. */
export function createValidateRecipeSchemaTool(): Tool {
    return tool({
        description:
            'Validate a candidate `create` graph WITHOUT seeding it: checks it is a JSON object keyed by model name (each value an array of records) and that every { "_ref": "alias" } resolves to a declared "_alias". Call this on EVERY candidate before dry_run_seed - it catches the structural mistakes (a dangling ref, a bare array) instantly and for free.',
        inputSchema: z.object({
            createGraphJson: z.string().describe("the complete candidate create graph as a JSON string"),
        }),
        execute: async ({ createGraphJson }) => {
            const result = validateRecipeGraph(createGraphJson);
            if (result.valid) return "VALID: the graph is structurally sound and every _ref resolves.";
            return `INVALID:\n${result.errors.map((error) => `- ${error}`).join("\n")}`;
        },
    });
}

/** Seed a candidate against the deployed SDK (`up` then teardown) to confirm the factory accepts it. */
export function createDryRunSeedTool(dryRunSeed: DryRunSeed): Tool {
    return tool({
        description:
            "Seed a candidate `create` graph against the client's LIVE factory (an `up`, then immediate teardown) to confirm the factory ACCEPTS it and returns valid auth+data - the authoritative check that the data can actually be created, short of running the test. Use it once you have a schema-valid candidate you believe is right; a failure here means the factory rejected the graph (a field/model it cannot create) - read its error and revise. Costs a real provision, so do NOT call it on every draft.",
        inputSchema: z.object({
            createGraphJson: z.string().describe("the complete candidate create graph as a JSON string"),
        }),
        execute: async ({ createGraphJson }) => {
            try {
                const result = await dryRunSeed(createGraphJson);
                return `${result.ok ? "SEED OK" : "SEED FAILED"}: ${result.detail}`;
            } catch (error) {
                return `dry_run_seed error: ${error instanceof Error ? error.message : String(error)}`;
            }
        },
    });
}

/**
 * Assemble the recipe-repair agent's tools from the injected capabilities, sharing one per-run output budget.
 * read_code / grep_code / git_diff / run_script / get_preview_env are the SAME capabilities the classifier uses
 * (the cloned repo + the live preview backend); validate_recipe_schema + dry_run_seed are recipe-specific. The
 * dry-run tool only appears when the SDK capability was wired (deps.dryRunSeed present).
 */
export function buildRepairRecipeTools(deps: RepairRecipeDeps): Record<string, Tool> {
    const cap = createToolBudget();
    const tools: Record<string, Tool> = {
        read_code: createReadCodeTool(deps.codebase, cap),
        grep_code: createGrepCodeTool(deps.codebase, cap),
        git_diff: createGitDiffTool(deps.codebase, cap),
        run_script: createRunScriptTool(deps.preview, cap),
        get_preview_env: createPreviewEnvTool(deps.preview, cap),
        validate_recipe_schema: createValidateRecipeSchemaTool(),
    };
    if (deps.dryRunSeed != null) {
        tools.dry_run_seed = createDryRunSeedTool(deps.dryRunSeed);
    }
    return tools;
}
