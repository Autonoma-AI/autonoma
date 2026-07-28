import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    findRecipeCreateGraphProblems,
    isRecord,
    ScenarioRecipesFileSchema,
    type ScenarioRecipesFile,
} from "@autonoma/types";
import { debugLog } from "../../core/debug";

export const RECIPE_FILE = "recipe.json";

/** The two `validation` fields the upload contract pins to a single literal value. */
const VALIDATION_STATUS = "validated";
const VALIDATION_PHASE = "ok";

/**
 * The recipe file as Autonoma accepts it. This is `ScenarioRecipesFileSchema` itself, not a
 * local restatement of it: a hand-mirrored copy silently drops whatever the copy forgot -
 * every key zod does not know about is stripped on parse - and the file then fails ingest
 * over a field that was present on disk.
 */
export type FullRecipeJson = ScenarioRecipesFile;

/**
 * Why `recipe.json` is not ready to submit. `absent` and `invalid` are different failures to
 * the agent that has to fix it - "you never wrote one" versus "the one you wrote is wrong
 * here" - so callers must be able to say which happened.
 */
export type RecipeReadResult =
    | { status: "ok"; recipe: FullRecipeJson }
    | { status: "absent" }
    | { status: "invalid"; problems: string[] };

/**
 * Read `recipe.json` from the output dir and hold it to the exact schema the API enforces on
 * upload, so a recipe that parses here cannot be rejected there for its shape.
 */
export async function loadRecipe(outputDir: string): Promise<RecipeReadResult> {
    const path = join(outputDir, RECIPE_FILE);

    let raw: string;
    try {
        raw = await readFile(path, "utf-8");
    } catch (err) {
        debugLog("No recipe.json yet", { path, err });
        return { status: "absent" };
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugLog("recipe.json is not valid JSON", { path, err });
        return { status: "invalid", problems: [`${RECIPE_FILE} is not valid JSON: ${message}`] };
    }

    const parsed = ScenarioRecipesFileSchema.safeParse(withValidationCeremony(json));
    if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `${path}: ${issue.message}`;
        });
        debugLog("recipe.json failed schema validation", { path, problems });
        return { status: "invalid", problems };
    }

    return { status: "ok", recipe: parsed.data };
}

/**
 * Everything in this recipe file that Autonoma will reject on upload, one message per
 * offending recipe. The schema cannot catch any of it - a `create` graph is an arbitrary
 * record, so a dangling `_ref` or a `"{{userEmail}}"` that resolves to nothing is a perfectly
 * valid string as far as it is concerned.
 *
 * The checks are `findRecipeCreateGraphProblems` from `@autonoma/types` - literally the
 * function the API runs on ingest - so this gate cannot drift from what the server accepts.
 * Running it here turns a rejected upload (or, worse, a dry run that fails minutes later)
 * into a fix the agent makes before it finishes.
 */
export function findRecipeUploadProblems(recipe: FullRecipeJson): string[] {
    return recipe.recipes.flatMap((entry) => {
        const declaredTokens = new Set(Object.keys(entry.variables ?? {}));
        return findRecipeCreateGraphProblems(entry.create, declaredTokens).map(
            (problem) => `"${entry.name}": ${problem}`,
        );
    });
}

/**
 * Fill in `validation.status` and `validation.phase`. Both are single-valued literals in the
 * upload contract, so they carry nothing the recipe's author decides - and a recipe rejected
 * for omitting a constant costs a whole re-launch of the coding agent. Anything else the
 * author wrote, including a wrong value for either field, is left alone for the parse to
 * reject with the field path.
 */
function withValidationCeremony(json: unknown): unknown {
    if (!isRecord(json) || !Array.isArray(json.recipes)) {
        return json;
    }

    const recipes = json.recipes.map((entry) => {
        if (!isRecord(entry)) {
            return entry;
        }

        const validation = isRecord(entry.validation) ? entry.validation : {};
        return {
            ...entry,
            validation: {
                ...validation,
                status: validation.status ?? VALIDATION_STATUS,
                phase: validation.phase ?? VALIDATION_PHASE,
            },
        };
    });

    return { ...json, recipes };
}
