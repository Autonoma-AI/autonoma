import type { PrismaClient } from "@autonoma/db";
import type { ScenarioData } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { recoverScenarioDataFromWebhook } from "./recover-scenario-data-from-webhook";

/** Eval-only fallback: recover a generation's scenario data from its `UP` webhook when `generatedData` is null (pre-#822). */
export async function recoverScenarioDataForGeneration(
    db: PrismaClient,
    generationId: string,
): Promise<ScenarioData | undefined> {
    const logger = rootLogger.child({ name: "recoverScenarioDataForGeneration" });
    logger.info("Recovering scenario data for generation", { generationId });

    const generation = await db.testGeneration.findUnique({
        where: { id: generationId },
        select: { scenarioInstance: { select: { id: true, status: true, scenario: { select: { name: true } } } } },
    });

    const instance = generation?.scenarioInstance;
    return recoverScenarioDataFromWebhook(
        db,
        instance != null
            ? { id: instance.id, status: instance.status, scenarioName: instance.scenario.name }
            : undefined,
        logger,
    );
}
