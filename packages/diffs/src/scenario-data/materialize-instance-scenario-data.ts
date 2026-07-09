import type { ScenarioInstanceStatus } from "@autonoma/db";
import type { Logger } from "@autonoma/logger";
import { materializeScenarioData } from "./materialize-scenario-data";
import type { ScenarioData } from "./types";

/**
 * The scenario-instance fields a resolver selects to build a {@link ScenarioData}
 * payload: the status, the create graph persisted at UP success, and the
 * scenario's name. Shared by the run and generation resolvers so both unwrap a
 * fetched instance the exact same way.
 */
export interface ScenarioInstanceData {
    status: ScenarioInstanceStatus;
    generatedData: unknown;
    scenario: { name: string };
}

/**
 * Unwrap a fetched scenario instance into the serializable {@link ScenarioData}
 * payload, gracefully returning `undefined` - so the caller omits the scenario
 * context - when the subject has no instance or UP never wrote generated data.
 *
 * This is the agent-agnostic core `resolveScenarioDataForGeneration` builds on:
 * it fetches the instance shape off its subject and hands it here, so the
 * unwrap-and-materialize path lives in one place.
 */
export function materializeInstanceScenarioData(
    instance: ScenarioInstanceData | null | undefined,
    logger: Logger,
): ScenarioData | undefined {
    if (instance == null) {
        logger.info("Subject has no scenario instance - omitting scenario context");
        return undefined;
    }

    if (instance.generatedData == null) {
        logger.info("Scenario instance has no generated data - omitting scenario context", {
            extra: { scenarioStatus: instance.status },
        });
        return undefined;
    }

    return materializeScenarioData(instance.scenario.name, instance.generatedData, logger);
}
