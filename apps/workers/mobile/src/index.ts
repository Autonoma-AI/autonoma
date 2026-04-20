import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker } from "@autonoma/workflow/worker";
import * as activities from "./activities";
import { env } from "./env";

runWithSentry({ name: "worker-mobile", dsn: env.SENTRY_DSN_WORKER_MOBILE }, async () => {
    logger.info("Starting mobile worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.MOBILE,
        activities,
        maxConcurrentActivityTaskExecutions: 2,
    });

    // Signal to Kubernetes that the worker is connected and ready to poll.
    await writeFile("/tmp/worker-ready", "1");

    logger.info("Mobile worker started, polling for tasks", { taskQueue: TaskQueue.MOBILE });

    let shuttingDown = false;
    const runPromise = worker.run();

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Received shutdown signal, stopping mobile worker", { signal, taskQueue: TaskQueue.MOBILE });

        try {
            await worker.shutdown();
            await runPromise;
            logger.info("Mobile worker shutdown complete", { signal, taskQueue: TaskQueue.MOBILE });
            process.exit(0);
        } catch (error) {
            logger.error("Mobile worker shutdown failed", error, { signal, taskQueue: TaskQueue.MOBILE });
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
