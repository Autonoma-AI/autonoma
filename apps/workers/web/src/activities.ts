import { runWebGenerationJob } from "@autonoma/engine-web/generation";
import { runWebReplayJob } from "@autonoma/engine-web/replay";
import { logger as rootLogger } from "@autonoma/logger";
import type { RunWebGenerationInput, RunWebReplayInput, WebActivities } from "@autonoma/workflow/activities";
import * as Sentry from "@sentry/node";
import { Context } from "@temporalio/activity";

export async function runWebGeneration(input: RunWebGenerationInput): Promise<void> {
    Sentry.getCurrentScope().setTag("generation_id", input.testGenerationId);
    const logger = rootLogger.child({ name: "runWebGeneration", testGenerationId: input.testGenerationId });
    logger.info("Starting web generation execution");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runWebGenerationJob(input.testGenerationId);
        logger.info("Web generation execution completed");
    } finally {
        clearInterval(heartbeat);
    }
}

export async function runWebReplay(input: RunWebReplayInput): Promise<void> {
    Sentry.getCurrentScope().setTag("run_id", input.runId);
    const logger = rootLogger.child({ name: "runWebReplay", runId: input.runId });
    logger.info("Starting web replay execution");

    const heartbeat = setInterval(() => Context.current().heartbeat(), 30_000);

    try {
        await runWebReplayJob(input.runId);
        logger.info("Web replay execution completed");
    } finally {
        clearInterval(heartbeat);
    }
}

// Compile-time check: ensure exported activities match the WebActivities contract.
({ runWebGeneration, runWebReplay }) satisfies WebActivities;
