import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { debugLog } from "../../core/debug";

/**
 * Render `recipe.json` as the test generator's data contract.
 *
 * The recipe is what actually writes rows to the database. `scenarios.md` is a
 * human-facing summary of the same intent, and the two drift: on a real run the
 * scenario listed `demo@northwindbank.com` and a placeholder password hash while
 * the recipe wrote `demo+{{testRunId}}@northwindbank.com` and a real password.
 * Every model that faithfully asserted the scenario's email produced tests that
 * could never pass. So the generator reads the recipe, and the scenario stays
 * what it was always meant to be - something a human reviews.
 *
 * Templated values are the reason this cannot just be dumped as JSON: a field
 * containing `{{testRunId}}` is different per run and must never be asserted
 * literally, which the raw file does not say out loud.
 */

/** Fields the recipe uses for wiring rows together, not data a test can see. */
const STRUCTURAL_KEYS: ReadonlySet<string> = new Set(["_alias", "_ref"]);

const TEMPLATE_TOKEN = /\{\{\s*\w+\s*\}\}/;

const recipeRowSchema = z.record(z.string(), z.unknown());

const recipeFileSchema = z.object({
    recipes: z.array(
        z.object({
            name: z.string(),
            description: z.string().optional(),
            create: z.record(z.string(), z.array(recipeRowSchema)).optional(),
        }),
    ),
});

export async function loadRecipeContext(outputDir: string): Promise<string> {
    let raw: string;
    try {
        raw = await readFile(join(outputDir, "recipe.json"), "utf-8");
    } catch (err) {
        debugLog("recipe.json not present; test generation falls back to scenarios.md alone", { err });
        return "";
    }

    const parsed = recipeFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        debugLog("recipe.json did not match the expected shape; skipping it", { issues: parsed.error.issues });
        return "";
    }

    const sections = parsed.data.recipes.map(renderRecipe);
    if (sections.length === 0) return "";

    return `\n## Test data (from recipe.json - THE source of truth)

These are the exact rows Autonoma writes to the database before your tests run. Assert against
these values, never against seed/fixture/mock data you find in the application's own source.

A value shown as \`<generated per run>\` is templated and differs on every run - never assert it
literally. Assert a stable neighbouring field instead.
${sections.join("\n")}`;
}

function renderRecipe(recipe: z.infer<typeof recipeFileSchema>["recipes"][number]): string {
    const lines = [`\n### Scenario "${recipe.name}"`];
    if (recipe.description != null) lines.push(`\n${recipe.description}`);

    for (const [model, rows] of Object.entries(recipe.create ?? {})) {
        lines.push(`\n**${model}** (${rows.length} row${rows.length === 1 ? "" : "s"})`);
        for (const row of rows) {
            const fields = Object.entries(row)
                .filter(([key]) => !STRUCTURAL_KEYS.has(key))
                .map(([key, value]) => `${key}=${renderValue(value)}`);
            if (fields.length === 0) continue;

            // The alias labels the row, because other rows point at it by that name.
            // Dropping it would leave every `belongs to X` reference dangling.
            const alias = row["_alias"];
            const label = typeof alias === "string" ? `${alias}: ` : "";
            lines.push(`- ${label}${fields.join(", ")}`);
        }
    }
    return lines.join("\n");
}

function renderValue(value: unknown): string {
    if (typeof value === "string") {
        return TEMPLATE_TOKEN.test(value) ? "<generated per run>" : JSON.stringify(value);
    }
    // A `_ref` object points at another row by its alias.
    if (typeof value === "object" && value !== null && "_ref" in value) {
        const ref = Reflect.get(value, "_ref");
        return typeof ref === "string" ? `(the row aliased ${ref})` : JSON.stringify(value);
    }
    return JSON.stringify(value);
}
