import { runMobileGenerationJob } from "@autonoma/engine-mobile/generation";
import { runMobileReplayJob } from "@autonoma/engine-mobile/replay";
import { logger as rootLogger } from "@autonoma/logger";
import type { MobileActivities, RunMobileGenerationInput, RunMobileReplayInput } from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";

export async function runMobileGeneration(input: RunMobileGenerationInput): Promise<void> {
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

export async function runMobileReplay(input: RunMobileReplayInput): Promise<void> {
    const logger = rootLogger.child({ name: "runMobileReplay", runId: input.runId });
    logger.info("Starting mobile replay execution");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runMobileReplayJob(input.runId);
        logger.info("Mobile replay execution completed");
    } finally {
        clearInterval(heartbeat);
    }
}

// Compile-time check: ensure exported activities match the MobileActivities contract.
({ runMobileGeneration, runMobileReplay }) satisfies MobileActivities;
