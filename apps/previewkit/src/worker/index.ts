import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker, workflowsPath } from "@autonoma/workflow/worker";
import * as Sentry from "@sentry/node";
import * as activities from "../activities/index";
import { getServices } from "../activities/index";
import { env } from "../env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

runWithSentry({ name: "worker-previewkit", dsn: env.SENTRY_DSN }, async () => {
    logger.info("Starting previewkit worker");

    // Prime the shared services singleton eagerly so a misconfiguration
    // (kubeconfig, AWS, GitHub app) fails fast at startup rather than on the
    // first activity. Activities reuse this same instance.
    await getServices();

    const worker = await createTemporalWorker({
        taskQueue: TaskQueue.PREVIEWKIT,
        activities,
        workflowsPath,
        maxConcurrentActivityTaskExecutions: 5,
        // Drain in-flight builds/deploys on shutdown instead of aborting them.
        // The KEDA scaler (deployment/apps/keda-worker-previewkit.yaml) scales on
        // Temporal queue size, not in-flight activities, so it routinely SIGTERMs
        // a worker that is mid-build. Without a grace, the SDK default (0) cancels
        // those builds instantly -> they surface as failed deploys. This sits
        // under the pod's terminationGracePeriodSeconds (1800s in
        // deployment/apps/worker-previewkit.yaml) so the build finishes first.
        shutdownGraceTimeMs: 25 * 60_000,
        interceptors: {
            activity: [sentryServiceInterceptor],
        },
    });

    // Signal to the Kubernetes readiness probe that the worker is up.
    await writeFile("/tmp/worker-ready", "1");

    logger.info("Previewkit worker started, polling for tasks", { taskQueue: TaskQueue.PREVIEWKIT });

    let shuttingDown = false;
    const runPromise = worker.run();

    const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;

        logger.info("Received shutdown signal, stopping previewkit worker", {
            signal,
            taskQueue: TaskQueue.PREVIEWKIT,
        });

        try {
            await worker.shutdown();
            await runPromise;
            // Drain any buffered build-log lines (the Loki sink batches) so the
            // tail of an in-flight build is not lost on rollout.
            await (await getServices()).buildLogSink?.close?.();
            logger.info("Previewkit worker shutdown complete", { signal, taskQueue: TaskQueue.PREVIEWKIT });
            await Sentry.flush(2000);
            process.exit(0);
        } catch (error) {
            logger.error("Previewkit worker shutdown failed", error, { signal, taskQueue: TaskQueue.PREVIEWKIT });
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
