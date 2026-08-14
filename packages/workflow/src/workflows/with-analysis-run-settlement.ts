import type { ObservabilityContext } from "@autonoma/logger";
import { type AnalysisRunOutcome, CANCELLED_RUN_REASON } from "@autonoma/types";
import { CancellationScope, isCancellation, log, proxyActivities } from "@temporalio/workflow";
import type { AnalysisActivities } from "../activities";
import { isApplicationUnlinkedFailure } from "../application-unlinked-failure";
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
 * non-cancellable scope or a cancelled workflow leaves the run dangling in `running` forever. The failure is
 * rethrown after settling only when it is a genuine failure or a Temporal cancellation - a run abandoned mid-flight
 * because its application was deleted/unlinked settles `cancelled` and returns normally, emitting no hard failure.
 *
 * Termination is not covered: Temporal runs no workflow code on terminate, so a run killed that way is closed out
 * by the DB supersede of whichever run replaces it. The proactive cancel on application delete/unlink uses Temporal
 * CANCELLATION for exactly this reason - it runs this settlement, terminate would not.
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
        const settlement = settlementForFailure(error, ids);
        outcome = settlement.outcome;
        if (settlement.rethrow) {
            rethrowFailure = () => {
                throw error;
            };
        }
    }

    const settled = await CancellationScope.nonCancellable(() => analysis.settleAnalysisRun({ snapshotId, outcome }));
    log.info("Analysis run settled", { ...ids, extra: settled });

    if (rethrowFailure != null) rethrowFailure();
}

/**
 * The outcome to settle a thrown run with, and whether to rethrow after settling.
 *
 * - A Temporal cancellation (the proactive cancel on application delete/unlink) settles `cancelled` and rethrows,
 *   so the workflow ends in the honest `Cancelled` state.
 * - An application-unlinked failure (the containment safety net for the race the cancel could not close) settles
 *   `cancelled` and does NOT rethrow: the run is over, and rethrowing would surface it as a hard failure.
 * - Anything else is a genuine failure: settle `failed` and rethrow so it surfaces.
 */
function settlementForFailure(
    error: unknown,
    ids: ObservabilityContext,
): { outcome: AnalysisRunOutcome; rethrow: boolean } {
    if (isCancellation(error)) {
        log.info("Analysis run cancelled; settling as cancelled", { ...ids, extra: { reason: CANCELLED_RUN_REASON } });
        return { outcome: { kind: "cancelled", reason: CANCELLED_RUN_REASON }, rethrow: true };
    }

    const reason = rootFailureMessage(error);
    if (isApplicationUnlinkedFailure(error)) {
        log.warn("Application was unlinked or deleted mid-run; settling as cancelled", { ...ids, extra: { reason } });
        return { outcome: { kind: "cancelled", reason }, rethrow: false };
    }

    log.error("Analysis run failed", { ...ids, extra: { failureReason: reason } });
    return { outcome: { kind: "failed", reason }, rethrow: true };
}
