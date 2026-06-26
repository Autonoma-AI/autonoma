import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker, workflowsPath } from "@autonoma/workflow/worker";
import * as Sentry from "@sentry/node";
import * as activities from "./activities/index";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

runWithSentry({ name: "worker-investigation", dsn: env.SENTRY_DSN_WORKER_INVESTIGATION }, async () => {
    logger.info("Starting investigation worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.INVESTIGATION,
        activities,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: 1,
        interceptors: {
            activity: [sentryServiceInterceptor],
        },
    });

    await writeFile("/tmp/worker-ready", "1");

    logger.info("Investigation worker started, polling for tasks", { taskQueue: TaskQueue.INVESTIGATION });

    let shuttingDown = false;
    const runPromise = worker.run();

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Received shutdown signal, stopping investigation worker", {
            signal,
            taskQueue: TaskQueue.INVESTIGATION,
        });

        try {
            await worker.shutdown();
            await runPromise;
            logger.info("Investigation worker shutdown complete", { signal, taskQueue: TaskQueue.INVESTIGATION });
            await Sentry.flush(2000);
            process.exit(0);
        } catch (error) {
            logger.error("Investigation worker shutdown failed", error, { signal, taskQueue: TaskQueue.INVESTIGATION });
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
