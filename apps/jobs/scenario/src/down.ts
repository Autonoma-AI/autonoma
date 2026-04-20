import { db } from "@autonoma/db";
import { logger, runWithSentry } from "@autonoma/logger";
import { EncryptionHelper, ScenarioManager } from "@autonoma/scenario";
import { downEnv } from "./down-env";
import { scenarioDown } from "./scenario-down";

const { SCENARIO_INSTANCE_ID: scenarioInstanceId } = downEnv;

logger.info("Starting scenario down", { scenarioInstanceId });

const encryption = new EncryptionHelper(downEnv.SCENARIO_ENCRYPTION_KEY);
const manager = new ScenarioManager(db, encryption);

await runWithSentry({ name: "scenario-manager", tags: { scenarioInstanceId }, dsn: downEnv.SENTRY_DSN_SCENARIO }, () =>
    scenarioDown({ scenarioInstanceId }, { manager }),
);
