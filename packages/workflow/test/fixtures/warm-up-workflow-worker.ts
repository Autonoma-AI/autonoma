import { logger as rootLogger } from "@autonoma/logger";

/**
 * Runs one throwaway workflow execution so the first real test does not pay the worker's cold start.
 *
 * A freshly created worker only becomes able to execute a workflow after it starts polling and evaluates the 4MB
 * workflow bundle inside a new VM context. On a contended 4-vCPU CI runner that takes 50-90s, and because it lands on
 * whichever test happens to run first, that test alone blows the 60s `testTimeout` while every later test in the same
 * suite finishes in ~2s. Call this at the end of `beforeAll` (whose timeout is sized for it) and the cost is paid
 * where it belongs.
 *
 * Failures are logged, never thrown: the warm-up's only job is to move latency, so a suite must not fail because a
 * throwaway execution did.
 */
export async function warmUpWorkflowWorker(execute: () => Promise<unknown>): Promise<void> {
    const logger = rootLogger.child({ name: "warmUpWorkflowWorker" });
    const startedAt = Date.now();

    logger.info("Warming up the workflow worker");
    await execute().catch((err) => {
        logger.warn("The warm-up execution failed - continuing, the worker is warm either way", { extra: { err } });
    });
    logger.info("Workflow worker warm", { extra: { elapsedMs: Date.now() - startedAt } });
}
