import { executeChild, log, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import type { WorkflowArchitecture } from "../types";
import { WORKFLOW_TYPE } from "./workflow-types";

const longRunning = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

const standard = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "15m",
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

interface RunReplayArgs {
    runId: string;
    architecture: WorkflowArchitecture;
    scenarioId?: string;
}

function dispatchReplay({ runId, architecture, scenarioId }: RunReplayArgs): Promise<void> {
    return executeChild(WORKFLOW_TYPE.RUN_REPLAY, {
        workflowId: `run-replay-${runId}`,
        taskQueue: TaskQueue.GENERAL,
        args: [{ runId, architecture, scenarioId }],
    });
}

export async function diffsAnalysisWorkflow(input: DiffsAnalysisInput): Promise<void> {
    const { snapshotId } = input;
    const ids = { snapshot: { snapshotId } };

    log.info("Diffs analysis workflow started", ids);

    const step1 = await longRunning.analyzeDiffs({ snapshotId });
    log.info("Diffs analysis step finished", { ...ids, extra: { replayCount: step1.replays.length } });

    if (step1.replays.length > 0) {
        log.info("Dispatching affected-test replays", { ...ids, extra: { replayCount: step1.replays.length } });
        await Promise.allSettled(step1.replays.map((run) => dispatchReplay(run)));
    }

    await standard.resolveDiffs({ snapshotId });
    log.info("Diffs resolution step finished", ids);

    try {
        log.info("Starting refinement loop child workflow", ids);
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
