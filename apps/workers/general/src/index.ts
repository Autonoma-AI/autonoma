import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker, workflowsPath } from "@autonoma/workflow/worker";
import * as Sentry from "@sentry/node";
import * as activities from "./activities/index";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

/**
 * Activities run concurrently PER POD, and this queue is memory-bound rather than CPU-bound: every concurrent
 * `scenarioUp` resolves its OWN copy of the scenario recipe (ScenarioRecipeStore.loadRecipePayload does not
 * cache, so activities sharing a scenarioId still each hold a resolved `fixtureJson`), on top of the off-heap
 * SDK request buffers. At 10, a snapshot fanning out many singleGenerationWorkflow runs at once drove the pod
 * from a ~500MiB baseline to ~1.0GiB and it was OOMKilled against its 1Gi limit mid-activity. Throughput here
 * comes from replicas, not from per-pod concurrency - KEDA scales this deployment on `general` queue depth up
 * to 100 pods. Raise only alongside the pod's memory limit, or once the recipe payload is shared per process.
 */
const MAX_CONCURRENT_ACTIVITIES = 4;

runWithSentry({ name: "worker-general", dsn: env.SENTRY_DSN_WORKER_GENERAL }, async () => {
    logger.info("Starting general worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.GENERAL,
        activities,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: MAX_CONCURRENT_ACTIVITIES,
        interceptors: {
            activity: [sentryServiceInterceptor],
        },
    });

    // Signal to Kubernetes that the worker is connected and ready to poll.
    await writeFile("/tmp/worker-ready", "1");

    logger.info("General worker started, polling for tasks", { taskQueue: TaskQueue.GENERAL });

    let shuttingDown = false;
    const runPromise = worker.run();

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Received shutdown signal, stopping general worker", { signal, taskQueue: TaskQueue.GENERAL });

        try {
            await worker.shutdown();
            await runPromise;
            logger.info("General worker shutdown complete", { signal, taskQueue: TaskQueue.GENERAL });
            await Sentry.flush(2000);
            process.exit(0);
        } catch (error) {
            logger.error("General worker shutdown failed", error, { signal, taskQueue: TaskQueue.GENERAL });
            await Sentry.flush(2000);
            process.exit(1);
        }
    };

    process.once("SIGTERM", () => {
        void shutdown("SIGTERM");
    });

    process.once("SIGINT", () => {
        void shutdown("SIGINT");
    });

    await runPromise;
});
