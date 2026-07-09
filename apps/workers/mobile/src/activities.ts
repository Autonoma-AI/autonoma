import { runMobileGenerationJob } from "@autonoma/engine-mobile/generation";
import { logger as rootLogger } from "@autonoma/logger";
import type { MobileActivities, RunMobileGenerationInput } from "@autonoma/workflow/activities";
import * as Sentry from "@sentry/node";
import { Context } from "@temporalio/activity";

export async function runMobileGeneration(input: RunMobileGenerationInput): Promise<void> {
    Sentry.getCurrentScope().setTag("generation_id", input.testGenerationId);
    const logger = rootLogger.child({ name: "runMobileGeneration", testGenerationId: input.testGenerationId });
    logger.info("Starting mobile generation execution");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runMobileGenerationJob(input.testGenerationId);
        logger.info("Mobile generation execution completed");
    } finally {
        clearInterval(heartbeat);
    }
}

// Compile-time check: ensure exported activities match the MobileActivities contract.
({ runMobileGeneration }) satisfies MobileActivities;
