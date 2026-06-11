import { ScenarioRecipeSchema } from "@autonoma/types";
import { z } from "zod";

/**
 * Frozen on-disk shape of a captured generation eval case (`input.json`).
 *
 * Contains everything the eval harness needs to reproduce the agent run without
 * a database: the raw test plan prompt, deployment URL, and unresolved scenario
 * recipe.
 */
export const generationEvalInputSchema = z.object({
    generationId: z.string().optional(),
    rawPrompt: z.string(),
    customInstructions: z.string().optional(),
    url: z.string(),
    file: z.string().optional(),
    applicationId: z.string(),
    sdkUrl: z.string().optional(),
    customHeaders: z.record(z.string(), z.string()).optional(),
    scenarioId: z.string().optional(),
    scenarioName: z.string().optional(),
    fixtureJson: ScenarioRecipeSchema.optional(),
    previewkitBypassToken: z.string().optional(),
});

export type GenerationEvalInput = z.infer<typeof generationEvalInputSchema>;
