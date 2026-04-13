import { readFile } from "node:fs/promises";
import { db } from "@autonoma/db";
import { scenarioUp as doScenarioUp } from "@autonoma/job-scenario/up";
import { logger as rootLogger } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import type { ScenarioUpInput, ScenarioUpOutput } from "@autonoma/workflow/activities";
import { getScenarioEncryptionKey } from "../../env";

const VALID_SCENARIO_JOB_TYPES = ["run", "generation"] as const;
type ScenarioJobType = (typeof VALID_SCENARIO_JOB_TYPES)[number];

export async function scenarioUp(input: ScenarioUpInput): Promise<ScenarioUpOutput> {
    const logger = rootLogger.child({ name: "scenarioUp", entityId: input.entityId, scenarioId: input.scenarioId });
    logger.info("Starting scenario up");

    if (!(VALID_SCENARIO_JOB_TYPES as readonly string[]).includes(input.scenarioJobType)) {
        throw new Error(
            `Invalid scenarioJobType "${input.scenarioJobType}". Expected one of: ${VALID_SCENARIO_JOB_TYPES.join(", ")}`,
        );
    }
    const type = input.scenarioJobType as ScenarioJobType;

    const encryption = new EncryptionHelper(getScenarioEncryptionKey());
    const manager = new ScenarioManager(db, encryption);

    await doScenarioUp({ type, entityId: input.entityId }, { db, manager });

    logger.info("Scenario up completed, reading instance ID", { entityId: input.entityId });

    // The scenario job writes instance ID to /tmp/scenario-instance-id once it
    // has successfully started the scenario environment.
    let scenarioInstanceId: string;
    try {
        scenarioInstanceId = (await readFile("/tmp/scenario-instance-id", "utf-8")).trim();
    } catch (cause) {
        throw new Error(
            "Scenario job completed but did not write the instance ID file at /tmp/scenario-instance-id. " +
                "Check scenario job logs for errors.",
            { cause },
        );
    }

    if (scenarioInstanceId.length === 0) {
        throw new Error("Scenario instance ID file is empty - the scenario job may have failed silently.");
    }

    logger.info("Scenario instance ID read", { entityId: input.entityId, scenarioInstanceId });
    return { scenarioInstanceId };
}
