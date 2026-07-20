import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflows/workflow-types";

/**
 * Hard ceiling on a single analysis pipeline's wall-clock life - the same safety net the shadow investigation
 * uses. The analysis workflow has no Temporal versioning, so a deploy that adds/reorders an activity strands
 * every in-flight run on a non-determinism error; without an execution timeout those hang in `Running` forever
 * and pile up. Shadow runs re-run on the next push, so reaping a stuck one costs nothing.
 */
const ANALYSIS_EXECUTION_TIMEOUT = "6h";

export interface TriggerAnalysisJobParams {
    /** The branch's real pending snapshot the pipeline operates on. */
    snapshotId: string;
}

/**
 * Start the merged analysis pipeline for a snapshot (an org that has analysis enabled - it replaces the diffs
 * job). The workflow id is idempotent (`analysis-<snapshotId>`) so a duplicate trigger is rejected rather than
 * re-run.
 */
export async function triggerAnalysisJob(params: TriggerAnalysisJobParams): Promise<void> {
    const { snapshotId } = params;

    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        logger.info("Triggering analysis pipeline");

        const client = await getTemporalClient();
        const workflowId = `analysis-${snapshotId}`;

        await client.workflow.start(WORKFLOW_TYPE.ANALYSIS, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.FAIL,
            taskQueue: TaskQueue.DIFFS,
            workflowExecutionTimeout: ANALYSIS_EXECUTION_TIMEOUT,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [{ snapshotId }],
        });

        logger.info("Analysis pipeline started", { workflowId });
    });
}

/**
 * Cancel the running analysis pipeline for the given twin snapshot. Called when a newer push supersedes the
 * head this run was launched for. Best-effort: a missing/already-finished workflow is logged, not thrown.
 */
export async function cancelAnalysisJob(snapshotId: string): Promise<void> {
    return await withObservabilityContext({ snapshot: { snapshotId } }, async () => {
        const workflowId = `analysis-${snapshotId}`;
        logger.info("Cancelling analysis pipeline for snapshot", { workflowId });

        try {
            const client = await getTemporalClient();
            const handle = client.workflow.getHandle(workflowId);

            try {
                await handle.describe();
                await handle.cancel();
                logger.info("Analysis pipeline cancelled successfully", { workflowId });
            } catch (error) {
                logger.info("Analysis pipeline not found or already completed", {
                    workflowId,
                    extra: { error: String(error) },
                });
            }
        } catch (error) {
            logger.error("Failed to cancel analysis pipeline", error, { workflowId });
            throw error;
        }
    });
}
