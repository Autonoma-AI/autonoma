import type { PrismaClient } from "@autonoma/db";
import type { ScenarioData } from "@autonoma/diffs";
import { logger as rootLogger } from "@autonoma/logger";
import { recoverScenarioDataFromWebhook } from "./recover-scenario-data-from-webhook";

/** Eval-only fallback: recover a run's scenario data from its `UP` webhook when `generatedData` is null (pre-#822). */
export async function recoverScenarioDataForRun(db: PrismaClient, runId: string): Promise<ScenarioData | undefined> {
    const logger = rootLogger.child({ name: "recoverScenarioDataForRun" });
    logger.info("Recovering scenario data for run", { runId });

    const run = await db.run.findUnique({
        where: { id: runId },
        select: { scenarioInstance: { select: { id: true, status: true, scenario: { select: { name: true } } } } },
    });

    const instance = run?.scenarioInstance;
    return recoverScenarioDataFromWebhook(
        db,
        instance != null
            ? { id: instance.id, status: instance.status, scenarioName: instance.scenario.name }
            : undefined,
        logger,
    );
}
