import { findRecipeCreateGraphProblems } from "@autonoma/types";

/** The result of a local (no-provisioning) validation of a candidate create graph. */
export interface RecipeGraphValidation {
    valid: boolean;
    /** Human-readable problems, most-structural first. Empty iff `valid`. */
    errors: string[];
}

/**
 * Validate a candidate create graph WITHOUT provisioning: is it structurally a `{ model: record[] }` object, does
 * every `{ "_ref": "alias" }` resolve to a declared `_alias`, and does every `{{token}}` it uses actually resolve?
 * This is the cheap first gate in the repair agent's loop - it catches the mistakes a blind edit makes (a bare
 * array, a dangling ref to an alias that was renamed or never created, a token invented while rewriting a value)
 * instantly, so the agent fixes them before spending a dry-run seed or a twin rerun. It does NOT check whether the
 * client's factory accepts the fields - that is what `dry_run_seed` is for.
 *
 * The checks themselves live in `@autonoma/types` (`findRecipeCreateGraphProblems`), shared with the planner CLI's
 * pre-upload gate and the API's save-time gate - so a graph this agent accepts is one those will accept too.
 */
export function validateRecipeGraph(createGraphJson: string): RecipeGraphValidation {
    let parsed: unknown;
    try {
        parsed = JSON.parse(createGraphJson);
    } catch (error) {
        return { valid: false, errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }

    const errors = findRecipeCreateGraphProblems(parsed);
    return { valid: errors.length === 0, errors };
}
