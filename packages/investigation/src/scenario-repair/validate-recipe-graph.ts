import { ScenarioCreateGraphSchema, findDanglingScenarioRefs } from "@autonoma/types";

/** The result of a local (no-provisioning) validation of a candidate create graph. */
export interface RecipeGraphValidation {
    valid: boolean;
    /** Human-readable problems, most-structural first. Empty iff `valid`. */
    errors: string[];
}

/**
 * Validate a candidate create graph WITHOUT provisioning: is it structurally a `{ model: record[] }` object, and
 * does every `{ "_ref": "alias" }` resolve to a declared `_alias`? This is the cheap first gate in the repair
 * agent's loop - it catches the mistakes a blind edit makes (a bare array, a dangling ref to an alias that was
 * renamed or never created) instantly, so the agent fixes them before spending a dry-run seed or a twin rerun.
 * It does NOT check whether the client's factory actually accepts the fields - that is what `dry_run_seed` is for.
 *
 * The create-graph SHAPE + `_alias`/`_ref` semantics come from `@autonoma/types` (`ScenarioCreateGraphSchema` +
 * `findDanglingScenarioRefs`), the same definitions the SDK provisioner uses - so this validator can never drift
 * from what the factory actually receives.
 */
export function validateRecipeGraph(createGraphJson: string): RecipeGraphValidation {
    let parsed: unknown;
    try {
        parsed = JSON.parse(createGraphJson);
    } catch (error) {
        return { valid: false, errors: [`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
    }

    const structural = ScenarioCreateGraphSchema.safeParse(parsed);
    if (!structural.success) {
        const errors = structural.error.issues.map((issue) => {
            const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
            return `${path}: ${issue.message}`;
        });
        return { valid: false, errors };
    }

    const dangling = findDanglingScenarioRefs(structural.data);
    if (dangling.length > 0) {
        return {
            valid: false,
            errors: dangling.map(
                (ref) => `Dangling reference: { "_ref": "${ref}" } points to an alias no record declares.`,
            ),
        };
    }

    return { valid: true, errors: [] };
}
