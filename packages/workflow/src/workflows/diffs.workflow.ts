import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflow-types";

const longRunning = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const shortLived = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

export interface DiffsAnalysisInput {
    snapshotId: string;
}

export async function diffsAnalysisWorkflow(input: DiffsAnalysisInput): Promise<void> {
    const { snapshotId } = input;
    const ids = { snapshot: { snapshotId } };

    log.info("Diffs analysis workflow started", ids);

    await longRunning.analyzeDiffs({ snapshotId });
    log.info("Diffs analysis step finished", ids);

    // The refinement loop validates the suite: analysis seeds a pending generation
    // for every affected test (plus any new tests the diffs agent authored), and
    // iteration 1 generates+heals them; later iterations heal whatever still fails.
    // A generation passing its review is the definition of "validated" - there is
    // no replay step. Marking + the loop share the catch so any failure finalizes
    // the job rather than leaving it stuck.
    try {
        await shortLived.markDiffsGenerating({ snapshotId });
        log.info("Diffs job marked generating; starting refinement loop child workflow", ids);
        await executeChild(WORKFLOW_TYPE.REFINEMENT_LOOP, {
            workflowId: `refinement-loop-${snapshotId}`,
            taskQueue: TaskQueue.GENERAL,
            args: [{ snapshotId, triggeredBy: "diffs" as const }],
        });
    } catch (error) {
        const failureReason = rootFailureMessage(error);
        log.error("Refinement loop failed; finalizing diffs job as failed", { ...ids, extra: { failureReason } });
        await shortLived.finalizeDiffs({ snapshotId, failureReason });
        throw error;
    }

    await shortLived.finalizeDiffs({ snapshotId });
    log.info("Diffs analysis workflow completed", ids);
}
