import { logger as rootLogger } from "@autonoma/logger";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { Worker } from "@temporalio/worker";

interface TestWorkflowEnvironmentTeardown {
    env?: TestWorkflowEnvironment;
    /** Entries may be undefined: a suite variable assigned in `beforeAll` holds nothing if that hook failed. */
    workers?: ReadonlyArray<Worker | undefined>;
    /** The settled `worker.run()` promises, so teardown waits for the workers to actually stop. */
    runner?: Promise<unknown>;
}

/**
 * Shuts down workers and the test environment, tolerating a setup that never finished.
 *
 * Everything here is optional on purpose: when `beforeAll` fails partway, an `afterAll` that assumes a worker exists
 * throws its own error and buries the real one.
 */
export async function teardownTestWorkflowEnvironment({
    env,
    workers,
    runner,
}: TestWorkflowEnvironmentTeardown): Promise<void> {
    const logger = rootLogger.child({ name: "teardownTestWorkflowEnvironment" });

    for (const worker of workers ?? []) worker?.shutdown();
    await runner?.catch((err) => {
        logger.warn("A worker rejected while shutting down", { extra: { err } });
    });
    await env?.teardown().catch((err) => {
        logger.warn("Test environment teardown failed", { extra: { err } });
    });
}
