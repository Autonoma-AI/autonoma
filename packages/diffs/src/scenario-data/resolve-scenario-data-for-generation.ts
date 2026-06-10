import type { PrismaClient } from "@autonoma/db";
import { logger as rootLogger } from "@autonoma/logger";
import { materializeInstanceScenarioData } from "./materialize-instance-scenario-data";
import type { ScenarioData } from "./types";

/**
 * Resolve the scenario instance a generation executed against and materialize
 * its generated-data graph into the serializable {@link ScenarioData} payload.
 *
 * The generation sibling of `resolveScenarioDataForRun`: a generation hangs off
 * the same first-class `ScenarioInstance` (#815) as a run, so this fetches the
 * identical instance shape off the generation and hands it to the shared
 * `materializeInstanceScenarioData` unwrap. Kept agent-agnostic so the
 * generation reviewer, resolution, and healing all share one resolution path.
 *
 * Gracefully returns `undefined` - and the caller omits the scenario context -
 * when the generation has no scenario instance, when UP never succeeded (so
 * `generatedData` was never written), or when the graph is otherwise empty.
 */
export async function resolveScenarioDataForGeneration(
    db: PrismaClient,
    generationId: string,
): Promise<ScenarioData | undefined> {
    const logger = rootLogger.child({ name: "resolveScenarioDataForGeneration" });
    logger.info("Resolving scenario data for generation", { generationId });

    const generation = await db.testGeneration.findUnique({
        where: { id: generationId },
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

    return materializeInstanceScenarioData(generation?.scenarioInstance, logger);
}
