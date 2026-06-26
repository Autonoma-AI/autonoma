import { logger } from "@autonoma/logger";
import { WorkflowIdConflictPolicy, WorkflowNotFoundError } from "@temporalio/client";
import type { PreviewDeployEvent } from "../activities/previewkit-activities";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import type { PreviewRedeployAppMode } from "../workflows/previewkit-redeploy-app.workflow";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

const SUPERSEDE_CANCEL_GRACE_MS = 30_000;

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
    await cancelInFlightPreviewWorkflow(client, workflowId);
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
    await cancelInFlightPreviewWorkflow(client, workflowId);
    await client.workflow.start(WORKFLOW_TYPE.PREVIEW_TEARDOWN, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
        taskQueue: TaskQueue.PREVIEWKIT,
        searchAttributes: getWorkflowSearchAttributes(),
        args: [{ event }],
    });

    logger.info("Preview teardown workflow started", { extra: { workflowId } });
}

export interface TriggerPreviewRedeployAppParams {
    event: PreviewDeployEvent;
    /** The environment's namespace, resolved from the env row by the caller. */
    namespace: string;
    /** The single app to redeploy. */
    appName: string;
    /** `rebuild` re-builds the image then redeploys; `restart` re-rolls the running pods. */
    mode: PreviewRedeployAppMode;
    /** Pin the config revision so a rebuild reproduces the environment's deployed topology. */
    configRevisionId?: string | undefined;
}

/**
 * Starts (or supersedes) a per-app redeploy for a (repo, pr). Shares the deploy
 * workflow's deterministic workflowId, so it supersedes any in-flight full
 * deploy/teardown for the PR via the same per-environment mutex as
 * {@link triggerPreviewDeploy}.
 */
export async function triggerPreviewRedeployApp(params: TriggerPreviewRedeployAppParams): Promise<void> {
    const { event, namespace, appName, mode, configRevisionId } = params;
    const workflowId = buildPreviewDeployWorkflowId(event.repoFullName, event.prNumber);

    logger.info("Triggering preview per-app redeploy workflow", {
        extra: { workflowId, repo: event.repoFullName, pr: event.prNumber, app: appName, mode },
    });

    const client = await getTemporalClient();
    await cancelInFlightPreviewWorkflow(client, workflowId);
    await client.workflow.start(WORKFLOW_TYPE.PREVIEW_REDEPLOY_APP, {
        workflowId,
        workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
        taskQueue: TaskQueue.PREVIEWKIT,
        searchAttributes: getWorkflowSearchAttributes(),
        args: [{ event, namespace, appName, mode, configRevisionId }],
    });

    logger.info("Preview per-app redeploy workflow started", { extra: { workflowId, app: appName, mode } });
}

/**
 * Best-effort graceful cancel of the in-flight workflow for an environment
 * before starting the next one. The explicit `cancel()` delivers the
 * cancellation signal so the old run aborts its build (releasing the buildkit
 * Job in seconds) and finalizes its build row cleanly. We wait briefly for that
 * graceful close before starting the replacement; otherwise `TERMINATE_EXISTING`
 * can hard-kill the old run before its supersede cleanup activity records the
 * build as `superseded`. The caller still starts with `TERMINATE_EXISTING` as
 * the hard backstop for a wedged run that never observes the cancel. A
 * missing/closed run (first push, already torn down) is the expected no-op path.
 */
async function cancelInFlightPreviewWorkflow(
    client: Awaited<ReturnType<typeof getTemporalClient>>,
    workflowId: string,
): Promise<void> {
    const handle = client.workflow.getHandle(workflowId);
    try {
        const description = await handle.describe();
        if (description.status.name !== "RUNNING") {
            logger.info("No running preview workflow to cancel", {
                extra: { workflowId, status: description.status.name },
            });
            return;
        }
        await handle.cancel();
        logger.info("Requested graceful cancel of in-flight preview workflow", {
            extra: { workflowId, graceMs: SUPERSEDE_CANCEL_GRACE_MS },
        });
        const closedGracefully = await waitForWorkflowClose(handle.result(), SUPERSEDE_CANCEL_GRACE_MS);
        if (closedGracefully) {
            logger.info("In-flight preview workflow closed after graceful cancel", { extra: { workflowId } });
        } else {
            logger.warn("Timed out waiting for graceful preview workflow cancel; starting with terminate backstop", {
                extra: { workflowId, graceMs: SUPERSEDE_CANCEL_GRACE_MS },
            });
        }
    } catch (err) {
        if (err instanceof WorkflowNotFoundError) {
            logger.info("No in-flight preview workflow to cancel (first push or already torn down)", {
                extra: { workflowId },
            });
            return;
        }
        // A real failure talking to Temporal (unreachable / transient RPC error),
        // not the benign "nothing to cancel" case. Don't block the supersede:
        // fall through so the caller's start() still runs with TERMINATE_EXISTING
        // as the backstop, but surface it as a warning (with the error) so a
        // persistent Temporal problem is visible instead of silently mislabeled
        // "already closed".
        logger.warn("Failed to gracefully cancel in-flight preview workflow; relying on terminate backstop", {
            extra: { workflowId, err },
        });
    }
}

async function waitForWorkflowClose(result: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            result.then(
                () => true,
                () => true,
            ),
            new Promise<false>((resolve) => {
                timeout = setTimeout(() => resolve(false), timeoutMs);
            }),
        ]);
    } finally {
        if (timeout != null) clearTimeout(timeout);
    }
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
