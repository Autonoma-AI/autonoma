import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import type { PreviewDeployEvent } from "../activities/previewkit-activities";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerPreviewDeployParams {
    event: PreviewDeployEvent;
    /** Pin the config revision to reproduce a redeploy's original topology. */
    configRevisionId?: string | undefined;
}

/**
 * Starts (or supersedes) the preview deploy workflow for a (repo, pr).
 *
 * The workflowId is deterministic per environment, so a new push to the same
 * PR uses {@link WorkflowIdConflictPolicy.TERMINATE_EXISTING} to terminate the
 * in-flight deploy and start fresh - this is the concurrency control that
 * replaces the old "two deploy() calls racing the same namespace".
 */
export async function triggerPreviewDeploy(params: TriggerPreviewDeployParams): Promise<void> {
    const { event, configRevisionId } = params;
    const workflowId = buildPreviewDeployWorkflowId(event.repoFullName, event.prNumber);

    logger.info("Triggering preview deploy workflow", {
        extra: { workflowId, repo: event.repoFullName, pr: event.prNumber, sha: event.headSha.slice(0, 7) },
    });

    const client = await getTemporalClient();
    await client.workflow.start(WORKFLOW_TYPE.PREVIEW_DEPLOY, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
        taskQueue: TaskQueue.PREVIEWKIT,
        searchAttributes: getWorkflowSearchAttributes(),
        args: [{ event, configRevisionId }],
    });

    logger.info("Preview deploy workflow started", { extra: { workflowId } });
}

export interface TriggerPreviewTeardownParams {
    event: PreviewDeployEvent;
}

/**
 * Starts the teardown workflow for a (repo, pr). It shares the deploy
 * workflow's deterministic workflowId, so TERMINATE_EXISTING (which is
 * workflow-type-agnostic) also terminates an in-flight deploy before tearing
 * the environment down - the same per-environment mutex the deploy path uses.
 */
export async function triggerPreviewTeardown(params: TriggerPreviewTeardownParams): Promise<void> {
    const { event } = params;
    const workflowId = buildPreviewDeployWorkflowId(event.repoFullName, event.prNumber);

    logger.info("Triggering preview teardown workflow", {
        extra: { workflowId, repo: event.repoFullName, pr: event.prNumber },
    });

    const client = await getTemporalClient();
    await client.workflow.start(WORKFLOW_TYPE.PREVIEW_TEARDOWN, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
        taskQueue: TaskQueue.PREVIEWKIT,
        searchAttributes: getWorkflowSearchAttributes(),
        args: [{ event }],
    });

    logger.info("Preview teardown workflow started", { extra: { workflowId } });
}

/**
 * Deterministic workflowId for an environment. `repoFullName` ("owner/repo")
 * is sanitized to the Temporal-safe, lowercased form so the same PR always
 * maps to the same workflow.
 */
export function buildPreviewDeployWorkflowId(repoFullName: string, prNumber: number): string {
    const slug = repoFullName.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase();
    return `previewkit-${slug}-${prNumber}`;
}
