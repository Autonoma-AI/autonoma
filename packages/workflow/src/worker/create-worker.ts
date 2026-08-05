import { logger } from "@autonoma/logger";
import { NativeConnection, Runtime, Worker, type WorkerInterceptors } from "@temporalio/worker";
import { env } from "../env";
import type { TaskQueue } from "../task-queues";
import { temporalSdkLogger } from "./temporal-sdk-logger";

/**
 * How many workflow executions a worker keeps in its sticky cache.
 *
 * This MUST be set. Left unset, the SDK derives it from V8's heap limit as
 * `floor((heapMiB - 200) * 600 / 1024)`, which budgets ~1.7MiB per cached
 * workflow. Ours cost ~34MiB each (measured: a workflow thread died with 33
 * resident workflows against its ~1120MiB heap), so the derived value
 * over-commits by ~20x - on a 2Gi pod it resolves to 539, roughly 18GiB of
 * workflow state. The cache then fills the WORKFLOW THREAD's heap, not the
 * pod's cgroup, and the thread dies with `ERR_WORKER_OUT_OF_MEMORY`, which
 * fails the whole worker process.
 *
 * Because the derivation scales with the heap, which scales with the memory
 * limit, raising a pod's memory does NOT fix this - it raises the ceiling and
 * the cache grows to fill it. Only an explicit cap bounds it.
 *
 * 16 holds ~550MiB of workflow state, about half the thread's heap, leaving
 * room for the workflows executing at any moment plus GC slack. Above the
 * per-pod steady state (a queue's live workflows spread across the replicas
 * KEDA runs), so the cost of the cap is rare cache misses that replay from
 * history - not a crash.
 */
const MAX_CACHED_WORKFLOWS = 16;

export interface CreateWorkerOptions {
    taskQueue: TaskQueue;
    workflowsPath?: string;
    // biome-ignore lint: Activity functions have varied signatures
    activities?: object;
    maxConcurrentActivityTaskExecutions?: number;
    /**
     * Overrides {@link MAX_CACHED_WORKFLOWS}. Raise only with evidence from
     * `temporal_sticky_cache_size` and the pod's working set, and never above
     * what the workflow thread's heap holds at ~34MiB per cached workflow.
     *
     * Workflow task concurrency follows this value (see
     * {@link workflowTaskConcurrencyFor}); there is no separate knob to keep in
     * step with it.
     */
    maxCachedWorkflows?: number;
    interceptors?: WorkerInterceptors;
    /**
     * Milliseconds `worker.shutdown()` waits for in-flight activities to drain
     * before cancelling them. The SDK default is `0`, which cancels running
     * activities the instant SIGTERM arrives - fine for short activities, but it
     * aborts long ones (e.g. a multi-minute preview build) on every rollout /
     * autoscaler scale-down. Workers that run long activities set this close to
     * their pod's `terminationGracePeriodSeconds` so a scaled-down worker
     * finishes its work instead of failing it.
     */
    shutdownGraceTimeMs?: number;
}

export async function createTemporalWorker(options: CreateWorkerOptions): Promise<Worker> {
    installTemporalRuntimeOnce();

    const log = logger.child({ name: "TemporalWorker" });

    log.info("Creating Temporal worker", {
        taskQueue: options.taskQueue,
        extra: { address: env.TEMPORAL_ADDRESS, namespace: env.TEMPORAL_NAMESPACE },
    });

    const connection = await NativeConnection.connect({ address: env.TEMPORAL_ADDRESS });
    const maxCachedWorkflows = options.maxCachedWorkflows ?? MAX_CACHED_WORKFLOWS;

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
        maxCachedWorkflows: maxCachedWorkflows,
        maxConcurrentWorkflowTaskExecutions: workflowTaskConcurrencyFor(maxCachedWorkflows),
        interceptors: options.interceptors,
        // Only set this when a caller provided it. The SDK merges its own
        // defaults via `{ ...defaults, ...userOptions }`, so an explicit
        // `shutdownGraceTime: undefined` clobbers the default with `undefined`
        // and then throws inside `msToNumber(undefined)` during option
        // compilation - crashing every worker that does not pass a grace time.
        ...(options.shutdownGraceTimeMs != null ? { shutdownGraceTime: options.shutdownGraceTimeMs } : {}),
    });

    log.info("Temporal worker created", { taskQueue: options.taskQueue });

    return worker;
}

/**
 * How many workflow tasks may execute at once, derived from the cache rather
 * than configured beside it. The two are coupled - the SDK clamps concurrency
 * to the cache size when it is higher, and up to 2 when it is lower, both with
 * a warning - so a caller who overrode only `maxCachedWorkflows` would silently
 * get a concurrency the cache cannot back, which is the eviction-while-executing
 * case the cap exists to prevent.
 *
 * Half keeps in-flight workflows under the cache from 3 up, and level with it at
 * 2 - the SDK's own floor while the cache is enabled. That floor makes a cache of
 * 1 the one value where concurrency exceeds it: degenerate rather than guarded,
 * since 0 (which disables the cache, and which the SDK exempts from the ordering
 * rule) is the only meaningful value below 2.
 */
function workflowTaskConcurrencyFor(maxCachedWorkflows: number): number {
    return Math.max(2, Math.floor(maxCachedWorkflows / 2));
}

let runtimeInstalled = false;

/**
 * Install the Temporal Runtime with our SDK logger forwarder, and - when
 * `TEMPORAL_METRICS_PORT` is set - the SDK's own Prometheus exporter. Must run
 * once per process, before the first `Worker.create`. Subsequent calls are
 * no-ops.
 *
 * Every worker process in the monorepo already has exactly one
 * `createTemporalWorker` call, so this guard is defensive (e.g. tests).
 *
 * Without the exporter the SDK's view of itself is invisible: `sticky_cache_size`,
 * `workflow_task_replay_latency` and slot usage exist only inside the process.
 * Every `temporal_*` series we had in Prometheus came from the Temporal server's
 * own Go workers (`client_name="temporal_go"`), so a worker sized its cache from
 * a heap estimate nobody could check against reality. The port is opt-in so
 * local runs and tests do not bind one.
 */
function installTemporalRuntimeOnce(): void {
    if (runtimeInstalled) return;

    const metricsPort = env.TEMPORAL_METRICS_PORT;
    if (metricsPort == null) {
        Runtime.install({ logger: temporalSdkLogger });
    } else {
        Runtime.install({
            logger: temporalSdkLogger,
            telemetryOptions: {
                metrics: { prometheus: { bindAddress: `0.0.0.0:${metricsPort}` } },
            },
        });
        logger.info("Temporal SDK metrics exporter listening", { extra: { metricsPort } });
    }

    runtimeInstalled = true;
}
