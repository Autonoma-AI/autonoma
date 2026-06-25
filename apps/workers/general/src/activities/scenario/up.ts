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

    const scenarioInstanceId = await doScenarioUp(
        { type, entityId: input.entityId, sdkUrlOverride: input.sdkUrlOverride },
        { db, manager },
    );

    logger.info("Scenario up completed", { entityId: input.entityId, scenarioInstanceId });
    return { scenarioInstanceId };
}
