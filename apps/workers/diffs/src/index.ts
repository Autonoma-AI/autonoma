import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker, workflowsPath } from "@autonoma/workflow/worker";
import * as Sentry from "@sentry/node";
import * as activities from "./activities/index";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

runWithSentry({ name: "worker-diffs", dsn: env.SENTRY_DSN_WORKER_DIFFS }, async () => {
    logger.info("Starting diffs worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.DIFFS,
        activities,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: 1,
        interceptors: {
            activity: [sentryServiceInterceptor],
        },
    });

    // Signal to Kubernetes that the worker is connected and ready to poll.
    await writeFile("/tmp/worker-ready", "1");

    logger.info("Diffs worker started, polling for tasks", { taskQueue: TaskQueue.DIFFS });

    let shuttingDown = false;
    const runPromise = worker.run();

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Received shutdown signal, stopping diffs worker", { signal, taskQueue: TaskQueue.DIFFS });

        try {
            await worker.shutdown();
            await runPromise;
            logger.info("Diffs worker shutdown complete", { signal, taskQueue: TaskQueue.DIFFS });
            await Sentry.flush(2000);
            process.exit(0);
        } catch (error) {
            logger.error("Diffs worker shutdown failed", error, { signal, taskQueue: TaskQueue.DIFFS });
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
