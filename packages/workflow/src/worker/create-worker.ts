import { logger } from "@autonoma/logger";
import { NativeConnection, Runtime, Worker, type WorkerInterceptors } from "@temporalio/worker";
import { env } from "../env";
import type { TaskQueue } from "../task-queues";
import { temporalSdkLogger } from "./temporal-sdk-logger";

export interface CreateWorkerOptions {
    taskQueue: TaskQueue;
    workflowsPath?: string;
    // biome-ignore lint: Activity functions have varied signatures
    activities?: object;
    maxConcurrentActivityTaskExecutions?: number;
    interceptors?: WorkerInterceptors;
}

export async function createTemporalWorker(options: CreateWorkerOptions): Promise<Worker> {
    installTemporalRuntimeOnce();

    const log = logger.child({ name: "TemporalWorker" });

    log.info("Creating Temporal worker", {
        taskQueue: options.taskQueue,
        extra: { address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE },
    });

    const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });

    const worker = await Worker.create({
        connection,
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue: options.taskQueue,
        workflowsPath: options.workflowsPath,
        bundlerOptions: {
            // Disable minification so workflow function names are preserved.
            webpackConfigHook: (config) => {
                config.optimization = { ...config.optimization, minimize: false };
                return config;
            },
        },
        activities: options.activities,
        maxConcurrentActivityTaskExecutions: options.maxConcurrentActivityTaskExecutions ?? 5,
        interceptors: options.interceptors,
    });

    log.info("Temporal worker created", { taskQueue: options.taskQueue });

    return worker;
}

let runtimeInstalled = false;

/**
 * Install the Temporal Runtime with our SDK logger forwarder. Must run once
 * per process, before the first `Worker.create`. Subsequent calls are no-ops.
 *
 * Every worker process in the monorepo already has exactly one
 * `createTemporalWorker` call, so this guard is defensive (e.g. tests).
 */
function installTemporalRuntimeOnce(): void {
    if (runtimeInstalled) return;
    Runtime.install({ logger: temporalSdkLogger });
    runtimeInstalled = true;
}
