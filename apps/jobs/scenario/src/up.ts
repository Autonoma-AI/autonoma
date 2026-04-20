import { db } from "@autonoma/db";
import { logger, runWithSentry } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { scenarioUp } from "./scenario-up";
import { upEnv } from "./up-env";

const { SCENARIO_JOB_TYPE: type, ENTITY_ID: entityId } = upEnv;

logger.info("Starting scenario up", { type, entityId });

const encryption = new EncryptionHelper(upEnv.SCENARIO_ENCRYPTION_KEY);
const manager = new ScenarioManager(db, encryption);

await runWithSentry({ name: "scenario-manager", tags: { type, entityId }, dsn: upEnv.SENTRY_DSN_SCENARIO }, () =>
    scenarioUp({ type, entityId }, { db, manager }),
);
