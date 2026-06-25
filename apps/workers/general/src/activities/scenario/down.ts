import { db } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { ScenarioDownInput } from "@autonoma/workflow/activities";
import { getScenarioEncryptionKey } from "../../env";
import { scenarioDown as doScenarioDown } from "./scenario-down";

export async function scenarioDown(input: ScenarioDownInput): Promise<void> {
    const logger = rootLogger.child({ name: "scenarioDown", scenarioInstanceId: input.scenarioInstanceId });
    logger.info("Starting scenario down");

    const encryption = new EncryptionHelper(getScenarioEncryptionKey());
    const manager = new ScenarioManager(db, encryption);

    await doScenarioDown({ scenarioInstanceId: input.scenarioInstanceId }, { manager });

    logger.info("Scenario down completed");
}
