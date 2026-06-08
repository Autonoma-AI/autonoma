import type { Logger } from "@autonoma/logger";
import type { ScenarioData, ScenarioEntities, ScenarioEntityRecord } from "./types";

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

/**
 * Keep only entity types whose value is a non-empty array of object records,
 * filtering out non-object array members (e.g. stray scalars). Returns
 * `undefined` when nothing survives, which signals "no scenario data".
 */
function normalizeEntities(raw: unknown): ScenarioEntities | undefined {
    if (!isPlainObject(raw)) return undefined;

    const entities: ScenarioEntities = {};
    for (const [entityType, value] of Object.entries(raw)) {
        if (!Array.isArray(value)) continue;
        const records = value.filter(isPlainObject);
        if (records.length === 0) continue;
        entities[entityType] = records;
    }

    return Object.keys(entities).length > 0 ? entities : undefined;
}

function isPlainObject(value: unknown): value is ScenarioEntityRecord {
    return typeof value === "object" && value != null && !Array.isArray(value);
}
