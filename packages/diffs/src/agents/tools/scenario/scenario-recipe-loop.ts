import type { AgentLoop } from "@autonoma/ai";
import type { ScenarioRecipeData } from "../../../scenario-recipe";

/**
 * Loop that holds the materialized scenario-**recipe** payloads in memory for the
 * scenarios referenced by the tests in an analysis's scope. Consumed by
 * `read_scenario_recipe_entities`, which reads full per-type records straight
 * from {@link ScenarioRecipeLoop.scenarioRecipes} with no DB or network access -
 * that's what keeps the analysis run DB-free while still allowing progressive
 * disclosure for large recipes.
 *
 * These are recipe templates (what a scenario is *designed to seed*), not the
 * per-run instance data the {@link ScenarioDataLoop} carries.
 *
 * Optional: an analysis whose tests reference no scenarios (or only scenarios
 * with no usable recipe) carries no payload, and the tool is simply not offered.
 */
export interface ScenarioRecipeLoop extends AgentLoop {
    readonly scenarioRecipes?: ScenarioRecipeData[];
}
