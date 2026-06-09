import type { Logger } from "@autonoma/logger";
import { normalizeEntities } from "./normalize-entities";
import type { ScenarioData } from "./types";

/**
 * Normalize a raw `ScenarioInstance.generatedData` graph into the serializable
 * {@link ScenarioData} payload. Pure (no DB, no I/O) and agent-agnostic, so the
 * loader, resolution, and healing all share one materialization path.
 *
 * Returns `undefined` when there is nothing usable to surface - a malformed
 * graph, or one with no entity records - so callers omit the scenario context
 * entirely rather than presenting an empty section. Historical instances
 * created before #815 carry a null `generatedData` and land here too.
 */
export function materializeScenarioData(
    scenarioName: string,
    generatedData: unknown,
    logger: Logger,
): ScenarioData | undefined {
    const entities = normalizeEntities(generatedData);
    if (entities == null) {
        logger.info("Scenario generated-data graph is empty or malformed - omitting scenario context", {
            extra: { scenarioName },
        });
        return undefined;
    }

    logger.info("Materialized scenario data", {
        extra: { scenarioName, entityTypes: Object.keys(entities).length },
    });
    return { scenarioName, entities };
}
