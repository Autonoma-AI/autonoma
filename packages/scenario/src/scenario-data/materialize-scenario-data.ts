import type { Logger } from "@autonoma/logger";
import { normalizeEntities } from "./normalize-entities";
import type { ScenarioData } from "./types";

/**
 * Normalize a raw `ScenarioInstance.generatedData` graph (or a recipe's resolved
 * `createPayload`) into the serializable {@link ScenarioData} payload.
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
