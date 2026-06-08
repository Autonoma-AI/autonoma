import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { materializeScenarioData } from "./materialize-scenario-data";
import type { ScenarioData } from "./types";

/**
 * Resolve the scenario instance a run executed against and materialize its
 * generated-data graph into the serializable {@link ScenarioData} payload.
 *
 * This is the single DB-touching step of the scenario-data capability, kept
 * agent-agnostic so loaders (replay review today), resolution, and healing all
 * share one resolution path instead of re-querying the join themselves.
 *
 * Gracefully returns `undefined` - and the caller omits the scenario context -
 * when the run has no scenario instance, when UP never succeeded (so
 * `generatedData` was never written), or when the graph is otherwise empty.
 */
export async function resolveScenarioDataForRun(db: PrismaClient, runId: string): Promise<ScenarioData | undefined> {
    const logger = rootLogger.child({ name: "resolveScenarioDataForRun" });
    logger.info("Resolving scenario data for run", { runId });

    const run = await db.run.findUnique({
        where: { id: runId },
        select: {
            scenarioInstance: {
                select: {
                    status: true,
                    generatedData: true,
                    scenario: { select: { name: true } },
                },
            },
        },
    });

    const instance = run?.scenarioInstance;
    if (instance == null) {
        logger.info("Run has no scenario instance - omitting scenario context", { runId });
        return undefined;
    }

    if (instance.generatedData == null) {
        logger.info("Scenario instance has no generated data - omitting scenario context", {
            runId,
            extra: { scenarioStatus: instance.status },
        });
        return undefined;
    }

    return materializeScenarioData(instance.scenario.name, instance.generatedData, logger);
}
