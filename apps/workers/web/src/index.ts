import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker } from "@autonoma/workflow/worker";
import * as activities from "./activities";

runWithSentry({ name: "worker-web" }, async () => {
    logger.info("Starting web worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.WEB,
        activities,
        maxConcurrentActivityTaskExecutions: 2,
    });

    // Signal to Kubernetes that the worker is connected and ready to poll.
    await writeFile("/tmp/worker-ready", "1");

    logger.info("Web worker started, polling for tasks", { taskQueue: TaskQueue.WEB });

    let shuttingDown = false;
    const runPromise = worker.run();

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Received shutdown signal, stopping web worker", { signal, taskQueue: TaskQueue.WEB });

        try {
            await worker.shutdown();
            await runPromise;
            logger.info("Web worker shutdown complete", { signal, taskQueue: TaskQueue.WEB });
            process.exit(0);
        } catch (error) {
            logger.error("Web worker shutdown failed", error, { signal, taskQueue: TaskQueue.WEB });
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
