import { z } from "zod";
import { scenarioEntitiesSchema } from "../scenario-data";

/**
 * One scenario's materialized **recipe template** - the data the scenario is
 * *designed to seed*, as declared in the point-in-time
 * `ScenarioRecipeVersion.fixtureJson` for a snapshot.
 *
 * This is deliberately a distinct shape from the per-run `ScenarioData`: a recipe
 * is the template (its `create` graph may still carry unresolved `{{token}}`
 * variable placeholders and `{ _ref }` relationships), whereas `ScenarioData`
 * holds the concrete rows a single run actually generated. The diffs analysis
 * agent runs *before* any replay, so no instance exists yet - the recipe is the
 * only artifact describing what each scenario seeds.
 */
export const scenarioRecipeDataSchema = z.object({
    /** Stable scenario id, carried for traceability. NOTE: lookups (the summary headings and the `read_scenario_recipe_entities` tool) key on `scenarioName`, not this id. */
    scenarioId: z.string(),
    /** Human-friendly scenario name (the point-in-time snapshot of it), surfaced in the summary and used as the disclosure-tool lookup key. */
    scenarioName: z.string(),
    /** Optional recipe description, when the recipe declares one. */
    description: z.string().optional(),
    /** The declared `create` graph, by model name - the entities this recipe seeds. */
    entities: scenarioEntitiesSchema,
});
export type ScenarioRecipeData = z.infer<typeof scenarioRecipeDataSchema>;
