import { db } from "@autonoma/db";
import { scenarioDown as doScenarioDown } from "@autonoma/job-scenario/down";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { ScenarioDownInput } from "@autonoma/workflow/activities";
import { getScenarioEncryptionKey } from "../../env";

export async function scenarioDown(input: ScenarioDownInput): Promise<void> {
    const logger = rootLogger.child({ name: "scenarioDown", scenarioInstanceId: input.scenarioInstanceId });
    logger.info("Starting scenario down");

    const encryption = new EncryptionHelper(getScenarioEncryptionKey());
    const manager = new ScenarioManager(db, encryption);

    await doScenarioDown({ scenarioInstanceId: input.scenarioInstanceId }, { manager });

    logger.info("Scenario down completed");
}
