import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

/**
 * Hard ceiling on a single shadow investigation's wall-clock life. A healthy run finishes well under an hour
 * (select + a wave of shadow web runs + classify, plus at most a few bounded repair/validation passes), so
 * this only ever fires on a run that is stuck. The important case: the investigation workflow has no Temporal
 * versioning (`patched()`/`getVersion()`), so any deploy that adds or reorders an activity strands every
 * in-flight workflow on a `WorkflowTaskFailed` non-determinism error - and without an execution timeout those
 * hang in `Running` forever and pile up (a batch of ~100 accumulated before this was added). The timeout is
 * the safety net that auto-reaps such casualties. These runs are shadow/observe-only and re-run on the next
 * push, so discarding a stuck one costs nothing.
 */
const INVESTIGATION_EXECUTION_TIMEOUT = "6h";

export interface TriggerInvestigationJobParams {
    snapshotId: string;
}

export interface TriggerInvestigationMergeJobParams {
    twinSnapshotId: string;
    mainSnapshotId: string;
    mainBranchId: string;
    organizationId: string;
}

/**
 * Start the merge-with-main workflow for a merged PR's investigation twin. The workflow id is idempotent
 * (`investigation-merge-<twinSnapshotId>`) so a re-delivered merge webhook is rejected rather than double-applied.
 */
export async function triggerInvestigationMergeJob(params: TriggerInvestigationMergeJobParams): Promise<void> {
    const { twinSnapshotId, mainSnapshotId, mainBranchId, organizationId } = params;

    return await withObservabilityContext({ snapshot: { snapshotId: twinSnapshotId } }, async () => {
        logger.info("Triggering investigation merge workflow", { extra: { mainSnapshotId } });

        const client = await getTemporalClient();
        const workflowId = `investigation-merge-${twinSnapshotId}`;

        await client.workflow.start(WORKFLOW_TYPE.INVESTIGATION_MERGE, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.INVESTIGATION,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [{ twinSnapshotId, mainSnapshotId, mainBranchId, organizationId }],
        });

        logger.info("Investigation merge workflow started", { workflowId });
    });
}

/**
 * Start the shadow investigation workflow for a snapshot. Runs in PARALLEL with the diffs job; the workflow
 * id is idempotent (`investigation-<snapshotId>`) so a duplicate trigger is rejected rather than re-run.
 */
export async function triggerInvestigationJob(params: TriggerInvestigationJobParams): Promise<void> {
    const { snapshotId } = params;

    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        logger.info("Triggering investigation workflow");

        const client = await getTemporalClient();
        const workflowId = `investigation-${snapshotId}`;

        await client.workflow.start(WORKFLOW_TYPE.INVESTIGATION, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.INVESTIGATION,
            workflowExecutionTimeout: INVESTIGATION_EXECUTION_TIMEOUT,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [{ snapshotId }],
        });

        logger.info("Investigation workflow started", { workflowId });
    });
}

/**
 * Cancel the running investigation workflow for the given investigation snapshot. Called when a newer push
 * supersedes the head this investigation was launched for, so we stop running shadow tests against a preview
 * that is about to be replaced. Best-effort: a missing/already-finished workflow is logged, not thrown.
 */
export async function cancelInvestigationJob(snapshotId: string): Promise<void> {
    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        const workflowId = `investigation-${snapshotId}`;
        logger.info("Cancelling investigation workflow for snapshot", { workflowId });

        try {
            const client = await getTemporalClient();
            const handle = client.workflow.getHandle(workflowId);

            try {
                await handle.describe();
                await handle.cancel();
                logger.info("Investigation workflow cancelled successfully", { workflowId });
            } catch (error) {
                logger.info("Investigation workflow not found or already completed", {
                    workflowId,
                    extra: { error: String(error) },
                });
            }
        } catch (error) {
            logger.error("Failed to cancel investigation workflow", error, { workflowId });
            throw error;
        }
    });
}
