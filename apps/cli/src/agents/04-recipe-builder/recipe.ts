import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { debugLog } from "../../core/debug";

const recipePayloadSchema = z.record(z.string(), z.array(z.record(z.string(), z.unknown())));

/** The recipe the agent generates and the CLI submits. Validated on read (below):
 *  it comes from the agent, so we don't blindly trust its shape before uploading. */
const fullRecipeSchema = z.object({
    version: z.number(),
    source: z.object({ discoverPath: z.string(), scenariosPath: z.string() }),
    validationMode: z.string(),
    recipes: z
        .array(
            z.object({
                name: z.string(),
                description: z.string(),
                create: recipePayloadSchema,
                validation: z.object({
                    status: z.string(),
                    method: z.string(),
                    up_ms: z.number().optional(),
                    down_ms: z.number().optional(),
                }),
            }),
        )
        .min(1),
});

export type RecipePayload = z.infer<typeof recipePayloadSchema>;
export type FullRecipeJson = z.infer<typeof fullRecipeSchema>;

export const RECIPE_FILE = "recipe.json";

/**
 * Read and validate the recipe the agent generated from the output dir. Returns
 * undefined when it's absent, unparseable, or malformed - callers treat any of
 * those as "not ready" - so a broken recipe is never submitted as if it were real.
 */
export async function loadRecipe(outputDir: string): Promise<FullRecipeJson | undefined> {
    const path = join(outputDir, RECIPE_FILE);

    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch (err) {
        debugLog("No recipe.json yet", { path, err });
        return undefined;
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        debugLog("recipe.json is not valid JSON", { path, err });
        return undefined;
    }

    const parsed = fullRecipeSchema.safeParse(json);
    if (!parsed.success) {
        debugLog("recipe.json failed schema validation", { path, issues: parsed.error.issues });
        return undefined;
    }
    return parsed.data;
}
