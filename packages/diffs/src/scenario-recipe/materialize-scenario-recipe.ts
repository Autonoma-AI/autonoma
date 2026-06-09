import type { Logger } from "@autonoma/logger";
import { z } from "zod";
import { normalizeEntities } from "../scenario-data";
import type { ScenarioRecipeData } from "./types";

/** Identifying fields a caller supplies for a recipe being materialized. */
export interface ScenarioRecipeIdentity {
    scenarioId: string;
    /** Fallback scenario name, used when the recipe's own `name` is absent. */
    scenarioName: string;
}

/**
 * Minimal view of `ScenarioRecipeVersion.fixtureJson` - just the pieces this
 * capability presents. The full shape is `ScenarioRecipeSchema` in
 * `@autonoma/types`; we deliberately validate only `create` (plus the optional
 * name/description) so a recipe with a usable `create` graph is never dropped over
 * an unrelated drift in, say, its embedded validation block.
 */
const recipeFixtureSchema = z
    .object({
        name: z.string().optional(),
        description: z.string().optional(),
        create: z.record(z.string(), z.unknown()),
    })
    .passthrough();

/**
 * Normalize a raw `ScenarioRecipeVersion.fixtureJson` into the serializable
 * {@link ScenarioRecipeData} payload. Pure (no DB, no I/O) and agent-agnostic.
 *
 * The recipe's declared `create` block uses the same `Record<model, records[]>`
 * shape as an instance's generated-data graph, so it shares the scenario-data
 * normalizer. What differs is the *meaning*: these are template entities (still
 * possibly carrying `{{token}}` variable placeholders), not concrete per-run rows.
 *
 * Returns `undefined` when the fixture is malformed or declares no usable entity
 * records, so callers omit that scenario rather than presenting an empty section.
 */
export function materializeScenarioRecipe(
    identity: ScenarioRecipeIdentity,
    fixtureJson: unknown,
    logger: Logger,
): ScenarioRecipeData | undefined {
    const parsed = recipeFixtureSchema.safeParse(fixtureJson);
    if (!parsed.success) {
        logger.warn("Scenario recipe fixtureJson failed to parse - omitting scenario from recipe context", {
            extra: {
                scenarioId: identity.scenarioId,
                scenarioName: identity.scenarioName,
                error: parsed.error.message,
            },
        });
        return undefined;
    }

    const recipe = parsed.data;
    const entities = normalizeEntities(recipe.create);
    if (entities == null) {
        logger.info("Scenario recipe declares no usable create entities - omitting it from recipe context", {
            extra: { scenarioId: identity.scenarioId, scenarioName: identity.scenarioName },
        });
        return undefined;
    }

    const scenarioName = recipe.name != null && recipe.name.length > 0 ? recipe.name : identity.scenarioName;

    logger.info("Materialized scenario recipe", {
        extra: { scenarioId: identity.scenarioId, scenarioName, entityTypes: Object.keys(entities).length },
    });

    const data: ScenarioRecipeData = { scenarioId: identity.scenarioId, scenarioName, entities };
    if (recipe.description != null && recipe.description.length > 0) data.description = recipe.description;
    return data;
}
