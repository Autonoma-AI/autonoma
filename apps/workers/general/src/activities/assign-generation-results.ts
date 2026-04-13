import { runGenerationAssignment } from "@autonoma/generation-assigner/run";
import { logger as rootLogger } from "@autonoma/logger";
import type { AssignGenerationResultsInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function assignGenerationResults(input: AssignGenerationResultsInput): Promise<void> {
    const logger = rootLogger.child({ name: "assignGenerationResults" });
    logger.info("Assigning generation results", {
        generationIds: input.generationIds,
        autoActivate: input.autoActivate,
    });

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runGenerationAssignment(input.generationIds, input.autoActivate);
        logger.info("Generation results assigned");
    } finally {
        clearInterval(heartbeat);
    }
}
