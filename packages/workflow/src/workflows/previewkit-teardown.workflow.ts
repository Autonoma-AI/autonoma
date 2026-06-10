import { log, proxyActivities } from "@temporalio/workflow";
import type { PreviewDeployEvent, PreviewkitActivities } from "../activities";
import { TaskQueue } from "../task-queues";

/**
 * Namespace deletion + addon deprovisioning can take a while; heartbeated so a
 * stuck/killed worker is detected and the activity reschedules. The activity is
 * idempotent (namespace-exists short-circuit), so retries are safe.
 */
const teardown = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.PREVIEWKIT,
});

export interface PreviewTeardownWorkflowInput {
    event: PreviewDeployEvent;
}

/**
 * Tears down a PR's preview environment. Started with the SAME deterministic
 * workflowId as `previewDeployWorkflow` (`previewkit-{slug}-{pr}`) and
 * TERMINATE_EXISTING, so closing a PR mid-deploy terminates the in-flight
 * deploy before the teardown runs - the workflowId is the per-environment
 * mutex across both workflow types.
 *
 * A teardown failure fails the workflow on purpose: an orphaned namespace is
 * the one state worth a loud Temporal failure.
 */
export async function previewTeardownWorkflow(input: PreviewTeardownWorkflowInput): Promise<void> {
    const { event } = input;
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber } };

    log.info("Preview teardown workflow started", ids);
    await teardown.teardownPreviewEnvironment({ event });
    log.info("Preview teardown workflow completed", ids);
}
