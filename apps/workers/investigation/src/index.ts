import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker, workflowsPath } from "@autonoma/workflow/worker";
import * as Sentry from "@sentry/node";
import * as activities from "./activities/index";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

/**
 * Activities run concurrently PER POD. The investigation activities are I/O-bound (LLM calls, git clones,
 * waiting on the web worker / preview SDK) and leave the pod's CPU near-idle, so serializing them to 1 wasted
 * the pod and made the fleet's throughput equal to the replica count - the queue starved and jobs took
 * tens of minutes to even start. Each activity clones the repo into its OWN mkdtemp dir (see
 * withSnapshotContext), so concurrent activities never collide on the filesystem. Kept at 4 to bound peak
 * memory (a few concurrent clones + LLM buffers against the 2Gi pod limit); raise once memory headroom under
 * real load is confirmed.
 */
const MAX_CONCURRENT_ACTIVITIES = 4;

runWithSentry({ name: "worker-investigation", dsn: env.SENTRY_DSN_WORKER_INVESTIGATION }, async () => {
    logger.info("Starting investigation worker");

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.INVESTIGATION,
        activities,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: MAX_CONCURRENT_ACTIVITIES,
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
