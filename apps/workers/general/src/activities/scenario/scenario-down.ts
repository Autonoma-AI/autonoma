import { logger as rootLogger } from "@autonoma/logger";
import type { ScenarioManager } from "@autonoma/scenario";

export interface ScenarioDownParams {
    scenarioInstanceId: string;
}

export interface ScenarioDownDeps {
    manager: ScenarioManager;
}

export async function scenarioDown(params: ScenarioDownParams, deps: ScenarioDownDeps): Promise<void> {
    const { scenarioInstanceId } = params;
    const { manager } = deps;
    const logger = rootLogger.child({ name: "scenarioDown", scenarioInstanceId });

    logger.info("Tearing down scenario instance");
    const instance = await manager.down(scenarioInstanceId);

    if (instance == null) {
        logger.warn("Scenario instance not found", { scenarioInstanceId });
        return;
    }

    if (instance.status === "DOWN_FAILED") {
        logger.error("Scenario down failed", { instanceId: instance.id, lastError: instance.lastError });
        throw new Error(
            `Scenario down failed: instanceId=${instance.id}, lastError=${JSON.stringify(instance.lastError)}`,
        );
    }

    logger.info("Scenario instance torn down", { instanceId: instance.id });
}
