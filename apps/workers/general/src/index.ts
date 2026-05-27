import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker, workflowsPath } from "@autonoma/workflow/worker";
import * as Sentry from "@sentry/node";
import * as activities from "./activities/index";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

runWithSentry({ name: "worker-general", dsn: env.SENTRY_DSN_WORKER_GENERAL }, async () => {
    logger.info("Starting general worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.GENERAL,
        activities,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: 10,
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
