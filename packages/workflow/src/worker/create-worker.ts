import { logger } from "@autonoma/logger";
import { NativeConnection, Worker } from "@temporalio/worker";
import { env } from "../env";
import type { TaskQueue } from "../task-queues";

export interface CreateWorkerOptions {
    taskQueue: TaskQueue;
    workflowsPath?: string;
    // biome-ignore lint: Activity functions have varied signatures
    activities?: object;
    maxConcurrentActivityTaskExecutions?: number;
}

export async function createTemporalWorker(options: CreateWorkerOptions): Promise<Worker> {
    const log = logger.child({ name: "TemporalWorker", taskQueue: options.taskQueue });

    log.info("Creating Temporal worker", {
        address: env.TEMPORAL_ADDRESS,
        namespace: env.TEMPORAL_NAMESPACE,
        taskQueue: options.taskQueue,
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
    });

    log.info("Temporal worker created", { taskQueue: options.taskQueue });

    return worker;
}
