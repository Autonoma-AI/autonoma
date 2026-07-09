import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { ScenarioUpInput, ScenarioUpOutput } from "@autonoma/workflow/activities";
import { getScenarioEncryptionKey } from "../../env";
import { scenarioUp as doScenarioUp } from "./scenario-up";

export async function scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput> {
    const logger = rootLogger.child({ name: "scenarioUp", entityId: input.entityId, scenarioId: input.scenarioId });
    logger.info("Starting scenario up");

    const encryption = new EncryptionHelper(getScenarioEncryptionKey());
    const manager = new ScenarioManager(db, encryption);

    const scenarioInstanceId = await doScenarioUp(
        { entityId: input.entityId, sdkUrlOverride: input.sdkUrlOverride },
        { db, manager },
    );

    logger.info("Scenario up completed", { entityId: input.entityId, scenarioInstanceId });
    return { scenarioInstanceId };
}
