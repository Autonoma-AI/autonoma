import { logger, withObservabilityContext } from "@autonoma/logger";
import { WorkflowIdConflictPolicy } from "@temporalio/client";
import { getTemporalClient } from "../client";
import { previewBuildWorkflowId } from "../preview-build-id";
import { getWorkflowSearchAttributes } from "../search-attributes";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflow-types";
import type { PreviewBuildWorkflowInput } from "../workflows/preview-build.workflow";

/**
 * Hard ceiling on one build's wall-clock life, above the workflow's own 285-minute settle budget so the budget is
 * what reports a stalled build rather than this backstop.
 */
const PREVIEW_BUILD_EXECUTION_TIMEOUT = "6h";

/**
 * For a repo whose branch could not be resolved: lack of analysis wiring must never cost a customer their preview.
 * Shares the id helper with the child-workflow path, so one commit always means one build workflow.
 */
export async function triggerPreviewBuild(input: PreviewBuildWorkflowInput): Promise<void> {
    const { target } = input;
    return await withObservabilityContext(
        {
            organization: { organizationId: target.organizationId },
            preview: { repo: target.repoFullName, headRef: target.headRef === "" ? undefined : target.headRef },
        },
        async () => {
            const client = await getTemporalClient();
            const workflowId = previewBuildWorkflowId(target);
            logger.info("Triggering preview build", {
                workflowId,
                extra: { pr: target.prNumber, headSha: target.headSha, reason: input.reason },
            });

            await client.workflow.start(WORKFLOW_TYPE.PREVIEW_BUILD, {
                workflowId,
                // The id is per commit, so a conflict means a redelivery of the same push. Attaching to the build
                // already under way is the right answer; terminating it would kill the Job it just created.
                workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
                taskQueue: TaskQueue.GENERAL,
                workflowExecutionTimeout: PREVIEW_BUILD_EXECUTION_TIMEOUT,
                searchAttributes: getWorkflowSearchAttributes(),
                args: [input],
            });

            logger.info("Preview build started", { workflowId });
        },
    );
}
