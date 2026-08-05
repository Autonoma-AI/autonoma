import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflow-types";
import type { AnalysisRunWorkflowInput } from "../workflows/analysis-run.workflow";

/**
 * Hard ceiling on one run's wall-clock life. Generous because a previewkit run owns the build too: on a
 * never-previewed branch impact analysis, a ~4.75h build wait, the Investigator fan-out and the Reporter run in
 * series. The workflow carries no Temporal versioning, so without an execution timeout a deploy that reorders a
 * stage would strand in-flight runs in `Running` forever.
 */
const ANALYSIS_RUN_EXECUTION_TIMEOUT = "10h";

/**
 * Keyed on the BRANCH with terminate-existing, so the newest commit cancels whatever was in flight - no double
 * build, no analysis of a stale head. The superseded run's AnalysisJob is closed out by the fresh run opening its
 * own snapshot.
 */
export async function triggerAnalysisRun(input: AnalysisRunWorkflowInput): Promise<void> {
    return await withObservabilityContext({ branch: { branchId: input.branchId } }, async () => {
        const client = await getTemporalClient();
        const workflowId = `analysis-run-${input.branchId}`;
        logger.info("Triggering analysis run", { extra: { workflowId, headSha: input.headSha } });

        await client.workflow.start(WORKFLOW_TYPE.ANALYSIS_RUN, {
            workflowId,
            workflowIdConflictPolicy: WorkflowIdConflictPolicy.TERMINATE_EXISTING,
            // Orchestration only - it clones nothing, so it does not belong on the clone worker, which runs one
            // activity at a time and is not KEDA-scaled. Its cloning stages still proxy to `diffs` by name, so a
            // saturated clone worker delays those stages instead of stopping the run from progressing at all.
            taskQueue: TaskQueue.GENERAL,
            workflowExecutionTimeout: ANALYSIS_RUN_EXECUTION_TIMEOUT,
            searchAttributes: getWorkflowSearchAttributes(),
            args: [input],
        });

        logger.info("Analysis run started", { extra: { workflowId } });
    });
}
