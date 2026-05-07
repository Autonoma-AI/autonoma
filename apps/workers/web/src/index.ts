import { writeFile } from "node:fs/promises";
import { logger, runWithSentry } from "@autonoma/logger";
import { TaskQueue } from "@autonoma/workflow";
import { createTemporalWorker } from "@autonoma/workflow/worker";
import { Context } from "@temporalio/activity";
import type { ActivityExecuteInput, ActivityInboundCallsInterceptor, Next, Worker } from "@temporalio/worker";
import * as activities from "./activities";
import { env } from "./env";
import { sentryServiceInterceptor } from "./sentry-service-interceptor";

// How long to wait for an activity before assuming this Job pod won't receive one
// and shutting down gracefully.
const IDLE_TIMEOUT_MS = 120_000;

class ShutdownAfterFirstActivityInterceptor implements ActivityInboundCallsInterceptor {
    private activityCompleted = false;

    constructor(
        private readonly getWorker: () => Worker | undefined,
        private readonly onActivityStarted: () => void,
    ) {}

    async execute(
        input: ActivityExecuteInput,
        next: Next<ActivityInboundCallsInterceptor, "execute">,
    ): Promise<unknown> {
        if (this.activityCompleted) {
            throw new Error("Worker is shutting down, should not receive new activities");
        }

        this.onActivityStarted();
        logger.info("Activity execution started");

        try {
            const result = await next(input);

            this.activityCompleted = true;
            const activityType = Context.current().info.activityType;
            logger.info("Activity execution completed - shutting down job pod", { activity: activityType });

            setImmediate(() => {
                void this.shutdownWorker(0);
            });

            return result;
        } catch (error) {
            this.activityCompleted = true;
            const activityType = Context.current().info.activityType;
            logger.error("Activity execution failed - shutting down job pod", { activity: activityType, error });

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
                logger.info("Worker shutdown complete");
            }
        } catch (error) {
            logger.error("Worker shutdown error", error);
        } finally {
            process.exit(exitCode);
        }
    }
}

runWithSentry({ name: "worker-web", dsn: env.SENTRY_DSN_WORKER_WEB }, async () => {
    logger.info("Starting web worker job");

    let worker: Worker | undefined;
    let shuttingDown = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const shutdownInterceptor = new ShutdownAfterFirstActivityInterceptor(
        () => worker,
        () => {
            if (idleTimer != null) {
                clearTimeout(idleTimer);
                idleTimer = undefined;
            }
        },
    );

    worker = await createTemporalWorker({
        taskQueue: TaskQueue.WEB,
        activities,
        maxConcurrentActivityTaskExecutions: 1,
        interceptors: {
            activity: [sentryServiceInterceptor, () => ({ inbound: shutdownInterceptor })],
        },
    });

    await writeFile("/tmp/worker-ready", "1");

    logger.info("Web worker job ready, waiting for activity", { taskQueue: TaskQueue.WEB });

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

    idleTimer = setTimeout(() => {
        logger.warn("No activity received within idle timeout, shutting down", {
            taskQueue: TaskQueue.WEB,
            idleTimeoutMs: IDLE_TIMEOUT_MS,
        });
        void shutdown("SIGTERM");
    }, IDLE_TIMEOUT_MS);

    process.once("SIGTERM", () => {
        void shutdown("SIGTERM");
    });

    process.once("SIGINT", () => {
        void shutdown("SIGINT");
    });

    await runPromise;
});
