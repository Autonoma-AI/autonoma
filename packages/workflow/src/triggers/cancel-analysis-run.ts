import { logger, withObservabilityContext } from "@autonoma/logger";
import { isGrpcServiceError } from "@temporalio/client";
import { analysisRunWorkflowId } from "../analysis-run-id";
import { getTemporalClient } from "../client";

/**
 * gRPC's NOT_FOUND (a stable wire-protocol status code): Temporal returns it from a cancel request when the
 * workflow was never started or has already closed. Both mean "there is no in-flight run to cancel".
 */
const GRPC_STATUS_NOT_FOUND = 5;

/**
 * Request cancellation of a branch's in-flight analysis run, if one is running. Used when an application is
 * deleted, unlinked from its repo, or its org disconnects GitHub: the result of a run against a repo we can no
 * longer reach is worthless, so the run must settle cleanly rather than crash on the null repo id mid-flight.
 *
 * CANCELLATION, not termination, is deliberate: the analysis workflow's settlement wrapper runs on cancel (inside
 * a non-cancellable scope) and settles the run `cancelled`; terminate runs no workflow code and would leave the
 * `AnalysisJob` dangling `running` forever. Best-effort and idempotent - a branch with no run in flight (never
 * started, or already closed) is a benign no-op, not an error.
 */
export async function cancelAnalysisRun(branchId: string): Promise<void> {
    return withObservabilityContext({ branch: { branchId } }, async () => {
        const workflowId = analysisRunWorkflowId(branchId);
        const client = await getTemporalClient();
        try {
            await client.workflow.getHandle(workflowId).cancel();
            logger.info("Requested cancellation of in-flight analysis run", { extra: { workflowId } });
        } catch (error) {
            if (isWorkflowNotFound(error)) {
                logger.info("No in-flight analysis run to cancel", { extra: { workflowId } });
                return;
            }
            throw error;
        }
    });
}

function isWorkflowNotFound(error: unknown): boolean {
    return isGrpcServiceError(error) && error.code === GRPC_STATUS_NOT_FOUND;
}
