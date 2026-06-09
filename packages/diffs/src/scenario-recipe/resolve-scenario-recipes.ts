import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { materializeScenarioRecipe } from "./materialize-scenario-recipe";
import type { ScenarioRecipeData } from "./types";

/**
 * Resolve the **recipe templates** for the scenarios referenced by the tests in
 * an analysis's scope, sourced from each scenario's point-in-time
 * `ScenarioRecipeVersion.fixtureJson` for the given snapshot, and materialize
 * them into serializable {@link ScenarioRecipeData} payloads.
 *
 * This is the single DB-touching step of the scenario-recipe capability, kept
 * agent-agnostic and mirroring the scenario-data resolver. It reads the recipe
 * version pinned to `[scenarioId, snapshotId]` (the recipe as it stood for this
 * snapshot), NOT any per-run instance: analysis runs before any replay, so no
 * instance exists yet - the recipe is the only artifact describing what each
 * scenario seeds.
 *
 * Scenarios with no recipe version for the snapshot, or whose fixture is empty
 * or malformed, are silently dropped (and logged), so the result holds only the
 * recipes that are actually presentable.
 */
export async function resolveScenarioRecipesForSnapshot(
    db: PrismaClient,
    snapshotId: string,
    scenarioIds: readonly string[],
): Promise<ScenarioRecipeData[]> {
    const logger = rootLogger.child({ name: "resolveScenarioRecipesForSnapshot" });

    const uniqueScenarioIds = [...new Set(scenarioIds)];
    if (uniqueScenarioIds.length === 0) {
        logger.info("No scenarios referenced by tests in scope - no recipe context to resolve", { snapshotId });
        return [];
    }

    logger.info("Resolving scenario recipes for snapshot", {
        snapshotId,
        extra: { scenarioCount: uniqueScenarioIds.length },
    });

    const recipeVersions = await db.scenarioRecipeVersion.findMany({
        where: { snapshotId, scenarioId: { in: uniqueScenarioIds } },
        select: { scenarioId: true, scenarioNameSnapshot: true, fixtureJson: true },
    });

    const recipes: ScenarioRecipeData[] = [];
    for (const version of recipeVersions) {
        const data = materializeScenarioRecipe(
            { scenarioId: version.scenarioId, scenarioName: version.scenarioNameSnapshot },
            version.fixtureJson,
            logger,
        );
        if (data != null) recipes.push(data);
    }

    // Stable, name-sorted order so the prompt (and any captured eval fixture) is
    // deterministic regardless of the DB's row order.
    recipes.sort((left, right) => left.scenarioName.localeCompare(right.scenarioName));

    logger.info("Resolved scenario recipes", {
        snapshotId,
        extra: { requested: uniqueScenarioIds.length, found: recipeVersions.length, materialized: recipes.length },
    });

    return recipes;
}
