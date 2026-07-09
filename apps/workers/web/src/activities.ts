import { runWebGenerationJob } from "@autonoma/engine-web/generation";
import { logger as rootLogger } from "@autonoma/logger";
import type { RunWebGenerationInput, WebActivities } from "@autonoma/workflow/activities";
import * as Sentry from "@sentry/node";
import { Context } from "@temporalio/activity";

export async function runWebGeneration(input: RunWebGenerationInput): Promise<void> {
    Sentry.getCurrentScope().setTag("generation_id", input.testGenerationId);
    const logger = rootLogger.child({ name: "runWebGeneration", testGenerationId: input.testGenerationId });
    logger.info("Starting web generation execution");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runWebGenerationJob(input.testGenerationId, input.urlOverride, input.sdkUrlOverride);
        logger.info("Web generation execution completed");
    } finally {
        clearInterval(heartbeat);
    }
}

({ runWebGeneration }) satisfies WebActivities;
