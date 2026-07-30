import { logger as rootLogger } from "@autonoma/logger";
import type { TestWorkflowEnvironment } from "@temporalio/testing";

/**
 * Stops the executions a test started but never saw finish. Call it from `afterEach` with the ids that test started.
 *
 * A `testTimeout` fails the test but does not stop the workflow it was awaiting, so the leftover execution runs on
 * into the next test - and two live executions poison each other two ways: they interleave in the mocked activities'
 * per-test script, and the time-skipping server (which jumps the clock whenever every workflow is blocked) can skip
 * the surviving test's activity past its heartbeat timeout. Terminating between tests keeps one slow test's failure
 * to one test instead of a cascade down the file.
 */
export async function terminateAbandonedExecutions(
    env: TestWorkflowEnvironment,
    workflowIds: readonly string[],
): Promise<void> {
    const logger = rootLogger.child({ name: "terminateAbandonedExecutions" });

    await Promise.all(
        workflowIds.map(async (workflowId) => {
            try {
                const handle = env.client.workflow.getHandle(workflowId);
                const description = await handle.describe();
                if (description.status.name !== "RUNNING") return;

                logger.warn("Terminating an execution its test abandoned", { extra: { workflowId } });
                await handle.terminate("abandoned by the test that started it");
            } catch (err) {
                logger.debug("Could not terminate a possibly-abandoned execution", { extra: { workflowId, err } });
            }
        }),
    );
}
