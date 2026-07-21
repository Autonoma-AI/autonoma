import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowExecutionAlreadyStartedError, WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

export interface TriggerPrDiffsJobParams {
    organizationId: string;
    branchId: string;
    headSha: string;
    /** Fallback base sha (the PR base) for the branch's first snapshot. */
    baseSha: string;
    /** The preview origin the diffs run seeds and tests against. */
    url: string;
}

/**
 * Start the PreviewKit "trigger diffs" workflow. Called by the PreviewKit runner
 * once a PR preview is ready, so the diffs run begins as a Temporal job (no HTTP
 * hop). The workflowId is keyed on (branch, head) with a FAIL conflict policy so
 * a redeploy of the same commit is a no-op; the diffs analysis it spawns keeps
 * its `diffs-analysis-${snapshotId}` id, preserving the existing supersede model.
 */
export async function triggerPrDiffsJob(params: TriggerPrDiffsJobParams): Promise<void> {
    const { organizationId, branchId, headSha, baseSha, url } = params;

    return await withObservabilityContext({ branch: { branchId } }, async () => {
        logger.info("Triggering PR diffs run workflow");

        const client = await getTemporalClient();
        const workflowId = `trigger-pr-diffs-${branchId}-${headSha}`;

        try {
            await client.workflow.start(WORKFLOW_TYPE.TRIGGER_PR_DIFFS, {
                workflowId,
                workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
                taskQueue: TaskQueue.DIFFS,
                searchAttributes: getWorkflowSearchAttributes(),
                args: [{ organizationId, branchId, headSha, baseSha, url }],
            });
            logger.info("PR diffs run workflow started", { workflowId });
        } catch (err) {
            // A redeploy of the same commit re-enters with the same (branch, head) workflowId. The FAIL conflict
            // policy is what dedups it - swallow the already-started error so a benign redeploy is an info no-op,
            // not a Sentry error surfaced by the PreviewKit runner. Any other failure still propagates.
            if (err instanceof WorkflowExecutionAlreadyStartedError) {
                logger.info("PR diffs run already in flight for this head; skipping duplicate trigger", { workflowId });
                return;
            }
            throw err;
        }
    });
}
