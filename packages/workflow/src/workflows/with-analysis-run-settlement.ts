import type { ObservabilityContext } from "@autonoma/logger";
import type { AnalysisRunOutcome } from "@autonoma/types";
import { CancellationScope, log, proxyActivities } from "@temporalio/workflow";
import type { AnalysisActivities } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";

const analysis = proxyActivities<Pick<AnalysisActivities, "settleAnalysisRun">>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

/**
 * Settlement promotes or closes the snapshot, so a body that throws still has to reach it, inside a
 * non-cancellable scope or a cancelled workflow leaves the run dangling in `running` forever. The original failure
 * is rethrown after settling.
 *
 * Termination is not covered: Temporal runs no workflow code on terminate, so a run killed that way is closed out
 * by the DB supersede of whichever run replaces it.
 */
export async function withAnalysisRunSettlement(
    snapshotId: string,
    ids: ObservabilityContext,
    body: () => Promise<void>,
): Promise<void> {
    let outcome: AnalysisRunOutcome = { kind: "succeeded" };
    let rethrowFailure: (() => never) | undefined;

    try {
        await body();
    } catch (error) {
        rethrowFailure = () => {
            throw error;
        };
        const reason = rootFailureMessage(error);
        outcome = { kind: "failed", reason };
        log.error("Analysis run failed", { ...ids, extra: { failureReason: reason } });
    }

    const settled = await CancellationScope.nonCancellable(() => analysis.settleAnalysisRun({ snapshotId, outcome }));
    log.info("Analysis run settled", { ...ids, extra: settled });

    if (rethrowFailure != null) rethrowFailure();
}
