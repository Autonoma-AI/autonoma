import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
    findRecipeCreateGraphProblems,
    isRecord,
    SCENARIO_VALIDATION_METHODS,
    ScenarioRecipesFileSchema,
    type ScenarioRecipesFile,
} from "@autonoma/types";
import type { z } from "zod";
import { debugLog } from "../../core/debug";

export const RECIPE_FILE = "recipe.json";

/** The two `validation` fields the upload contract pins to a single literal value. */
const VALIDATION_STATUS = "validated";
const VALIDATION_PHASE = "ok";
/** The method every recipe written through this CLI was validated with (`sdk up`/`sdk down`). */
const VALIDATION_METHOD = "endpoint-up-down";
/** Membership over the schema's own method list, so this can never drift from what parses. */
const VALIDATION_METHODS: ReadonlySet<string> = new Set(SCENARIO_VALIDATION_METHODS);

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
    return await loadRecipeFile(join(outputDir, RECIPE_FILE));
}

/** The same read, against an explicit path - what `sdk check` points at an arbitrary file. */
export async function loadRecipeFile(path: string): Promise<RecipeReadResult> {
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
        return { status: "invalid", problems: [`${path} is not valid JSON: ${message}`] };
    }

    const normalized = withValidationCeremony(json);
    const parsed = ScenarioRecipesFileSchema.safeParse(normalized);
    if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => describeIssue(issue, normalized));
        debugLog("recipe.json failed schema validation", { path, problems });
        return { status: "invalid", problems };
    }

    return { status: "ok", recipe: parsed.data };
}

/**
 * One schema issue as `<field path>: <what's wrong> (found: <value>)`. Zod names the expected
 * value but never the offending one, which leaves messages like `Invalid input: expected
 * "validated"` with no way to tell WHICH value has to change - so we resolve the value at the
 * issue's path and print it alongside.
 */
function describeIssue(issue: z.core.$ZodIssue, root: unknown): string {
    const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    const found = valueAtPath(root, issue.path);
    if (found === undefined) return `${field}: ${issue.message}`;
    return `${field}: ${issue.message} (found: ${JSON.stringify(found)})`;
}

/** Walk a zod issue path into the parsed JSON. `undefined` when the path doesn't resolve. */
function valueAtPath(root: unknown, path: ReadonlyArray<PropertyKey>): unknown {
    let current = root;
    for (const key of path) {
        if (Array.isArray(current) && typeof key === "number") {
            current = current[key];
            continue;
        }
        if (!isRecord(current)) return undefined;
        current = current[String(key)];
    }
    return current;
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
 * Rewrite each recipe's `validation` block to the only values the upload contract accepts.
 * The block is pure ceremony: `status` and `phase` are single-valued literals and `method`
 * is how the CLI drives the endpoint, so none of the three carries a decision the recipe's
 * author makes. What the CLI actually gates on is real - the completion marker, a parseable
 * recipe, and a `create` graph with no dangling refs - and a recipe held back over a constant
 * costs a whole re-launch of the coding agent. Every other field the author wrote (`up_ms`,
 * anything the schema passes through) is left alone.
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
                status: VALIDATION_STATUS,
                phase: VALIDATION_PHASE,
                method: isKnownValidationMethod(validation.method) ? validation.method : VALIDATION_METHOD,
            },
        };
    });

    return { ...json, recipes };
}

/** Whether the author's `validation.method` is one the upload contract already knows. */
function isKnownValidationMethod(method: unknown): boolean {
    return typeof method === "string" && VALIDATION_METHODS.has(method);
}
