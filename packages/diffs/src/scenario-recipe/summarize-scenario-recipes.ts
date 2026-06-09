import { summarizeEntities } from "../scenario-data";
import type { ScenarioRecipeData } from "./types";

/**
 * Render a bounded, human-legible summary of every scenario **recipe template**
 * referenced by the tests in the analysis's scope. For each scenario it inlines
 * the declared `create` graph - per entity type: the count, each record's
 * `_alias`, and 1-2 identifying field values - so the analysis agent can reason
 * about what data each scenario is *designed to seed* when judging which tests a
 * diff affects. Pure: no DB, no I/O.
 *
 * This is template (recipe) data, NOT per-run instance data: analysis runs
 * before any replay, so no scenario instance exists yet. Field values may still
 * be unresolved variable placeholders (e.g. `{{testRunId}}`). The per-run sibling
 * is `summarizeScenarioData` in `../scenario-data`.
 *
 * Returns `undefined` when there are no recipes to present, so the caller can omit
 * the section entirely rather than render an empty heading.
 */
export function summarizeScenarioRecipes(recipes: ScenarioRecipeData[]): string | undefined {
    if (recipes.length === 0) return undefined;

    const intro = [
        "The tests in scope reference the scenarios below. Each block is the scenario's **recipe template** - the data it is *designed to seed* - resolved from the recipe as it stood for this snapshot.",
        "",
        "This is template data, not the data of any single run: analysis happens before any replay, so no instance exists yet. Field values may still be unresolved placeholders (e.g. `{{testRunId}}`). Use the `read_scenario_recipe_entities` tool to read the full records a scenario declares for any entity type.",
    ].join("\n");

    const blocks = recipes.map((recipe) => summarizeRecipe(recipe));

    return [intro, "", blocks.join("\n\n")].join("\n");
}

function summarizeRecipe(recipe: ScenarioRecipeData): string {
    const body = summarizeEntities(recipe.entities, {
        // Scenario names are application-controlled free text; render the example
        // call's string args via JSON.stringify so a name/type containing a quote
        // still produces a well-formed, copy-pasteable tool call.
        moreRecords: (entityType, remaining) =>
            `- ...and ${remaining} more. Call \`read_scenario_recipe_entities(${JSON.stringify(recipe.scenarioName)}, ${JSON.stringify(entityType)})\` for the full list.`,
        moreTypes: (remaining) =>
            `### ...and ${remaining.length} more entity types: ${remaining.join(", ")}. Use \`read_scenario_recipe_entities\` to read any of them.`,
    });

    const heading = `## Scenario: ${recipe.scenarioName}`;
    const lines = recipe.description != null ? [heading, recipe.description, "", body] : [heading, "", body];
    return lines.join("\n");
}
