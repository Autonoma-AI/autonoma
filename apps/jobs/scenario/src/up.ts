import { writeFile } from "node:fs/promises";
import { db } from "@autonoma/db";
import { logger } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { scenarioUp } from "./scenario-up";
import { upEnv } from "./up-env";

// When this job runs as a standalone container, the instance id is surfaced to
// the orchestrator via this file. The in-process worker activity does NOT use
// this path - it consumes the value returned by scenarioUp() directly.
const INSTANCE_ID_OUTPUT_PATH = "/tmp/scenario-instance-id";

const { SCENARIO_JOB_TYPE: type, ENTITY_ID: entityId } = upEnv;

logger.info("Starting scenario up", { type, entityId });

const encryption = new EncryptionHelper(upEnv.SCENARIO_ENCRYPTION_KEY);
const manager = new ScenarioManager(db, encryption);

try {
    const scenarioInstanceId = await scenarioUp({ type, entityId }, { db, manager });
    await writeFile(INSTANCE_ID_OUTPUT_PATH, scenarioInstanceId, "utf-8");
    process.exit(0);
} catch (error) {
    logger.error("Scenario up failed", error, { type, entityId });
    process.exit(1);
}
