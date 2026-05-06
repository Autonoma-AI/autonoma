import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker } from "@autonoma/workflow/worker";
import { Context } from "@temporalio/activity";
import type { ActivityExecuteInput, ActivityInboundCallsInterceptor, Next, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

class ShutdownAfterFirstActivityInterceptor implements ActivityInboundCallsInterceptor {
    private activityCompleted = false;

    constructor(private readonly getWorker: () => Worker | undefined) {}

    async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, "execute">,
    ): Promise<unknown> {
        if (this.activityCompleted) {
            throw new Error("Worker is shutting down, should not receive new activities");
        }

        logger.info("Activity execution started");

        try {
            const result = await next(input);

            this.activityCompleted = true;
            const activityType = Context.current().info.activityType;
            logger.info("Activity execution completed - initiating worker shutdown", { activity: activityType });

            // Shutdown worker asynchronously after returning result
            setImmediate(() => {
                void this.shutdownWorker(0);
            });

            return result;
        } catch (error) {
            this.activityCompleted = true;
            const activityType = Context.current().info.activityType;
            logger.error("Activity execution failed - initiating worker shutdown", { activity: activityType, error });

            setImmediate(() => {
                void this.shutdownWorker(1);
            });

            throw error;
        }
    }

    private async shutdownWorker(exitCode: number): Promise<void> {
        try {
            const worker = this.getWorker();
            if (worker != null) {
                await worker.shutdown();
                logger.info("Worker shutdown complete - pod will terminate");
            }
        } catch (error) {
            logger.error("Worker shutdown error", error);
        } finally {
            process.exit(exitCode);
        }
    }
}

runWithSentry({ name: "worker-mobile", dsn: env.SENTRY_DSN_WORKER_MOBILE }, async () => {
    logger.info("Starting mobile worker (one activity per worker)");

    let worker: Worker | undefined;

    const shutdownInterceptor = new ShutdownAfterFirstActivityInterceptor(() => worker);

    worker = await createTemporalWorker({
        taskQueue: TaskQueue.MOBILE,
        activities,
        maxConcurrentActivityTaskExecutions: 1,
        interceptors: {
            activity: [sentryServiceInterceptor, () => ({ inbound: shutdownInterceptor })],
        },
    });

    await writeFile("/tmp/worker-ready", "1");

    logger.info("Mobile worker started, will handle ONE activity then shutdown", { taskQueue: TaskQueue.MOBILE });

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
