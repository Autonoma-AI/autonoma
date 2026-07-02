import { logger as rootLogger } from "@autonoma/logger";
import { type LanguageModel, Output, generateText } from "ai";
import { z } from "zod";
import { withRetry } from "../retry";
import { RECIPE_EDITOR_SYSTEM_PROMPT, type RecipeEditInput, buildRecipeEditPrompt } from "./edit-recipe-prompt";

// One structured pass (no tool loop); a tight window is plenty and a slow call means an overloaded provider.
const EDIT_TIMEOUT_MS = 2 * 60_000;

/** The model emits the full new create graph as a JSON string plus a one-line summary. */
const RecipeEditForModel = z.object({
    createGraphJson: z.string(),
    summary: z.string(),
});

/** A create graph is a JSON object keyed by model name (arrays of records); never a bare array or scalar. */
const CreateGraphSchema = z.record(z.string(), z.unknown());

export interface RecipeEdit {
    /** The complete new `create` graph (validated as an object), ready to write into a recipe's fixtureJson. */
    createGraph: Record<string, unknown>;
    /** One sentence describing what changed. */
    summary: string;
}

export interface EditRecipeCreateGraphDeps {
    /** The model that produces the edit (the investigation classifier model). */
    model: LanguageModel;
}

/**
 * Turn a diagnosed recipe change into a concrete new `create` graph. The model returns the whole edited graph as
 * a JSON string; we parse and validate it is a JSON object before returning. Throws when the model output cannot
 * be produced or is not a valid create graph - the caller (the acting loop) contains that and skips the repair,
 * so a bad edit never mutates a live recipe.
 */
export async function editRecipeCreateGraph(
    input: RecipeEditInput,
    deps: EditRecipeCreateGraphDeps,
): Promise<RecipeEdit> {
    const logger = rootLogger.child({ name: "editRecipeCreateGraph" });
    logger.info("Editing scenario recipe create graph");

    const result = await withRetry(
        () =>
            generateText({
                model: deps.model,
                system: RECIPE_EDITOR_SYSTEM_PROMPT,
                output: Output.object({ schema: RecipeEditForModel }),
                prompt: buildRecipeEditPrompt(input),
                abortSignal: AbortSignal.timeout(EDIT_TIMEOUT_MS),
            }),
        { label: "recipe-edit", tries: 2 },
    );

    const createGraph = CreateGraphSchema.parse(JSON.parse(result.output.createGraphJson));
    logger.info("Recipe create graph edited", { extra: { summary: result.output.summary } });
    return { createGraph, summary: result.output.summary };
}
