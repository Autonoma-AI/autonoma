import { log, proxyActivities } from "@temporalio/workflow";
import type { DiffsActivities } from "../activities";
import { TaskQueue } from "../task-queues";

const prepare = proxyActivities<DiffsActivities>({
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.DIFFS,
});

export interface TriggerPrDiffsInput {
    organizationId: string;
    branchId: string;
    headSha: string;
    baseSha: string;
    url: string;
}

/**
 * Entry point for a PreviewKit-managed PR preview that has just gone ready. The
 * PreviewKit runner starts this workflow directly (via the Temporal client), so
 * the test run begins internally with no HTTP hop. The `prepareDiffsRun` activity
 * runs the shared DiffsRunPreparer - the SAME sequence the API uses: create the
 * snapshot (superseding + cancelling any in-flight run on the branch), start the
 * diffs analysis workflow top-level, and fan out the analysis shadow. The diffs
 * run is started top-level (not as an awaited child) so a later commit supersedes
 * it cleanly, exactly as the API path does.
 */
export async function triggerPrDiffsWorkflow(input: TriggerPrDiffsInput): Promise<void> {
    const ids = { branch: { branchId: input.branchId }, extra: { headSha: input.headSha } };
    log.info("Trigger PR diffs workflow started", ids);

    const prepared = await prepare.prepareDiffsRun(input);
    if (prepared.skipped) {
        log.info("Diffs run skipped: head already analyzed, no new commits", ids);
        return;
    }

    log.info("Diffs run prepared and started", {
        branch: { branchId: input.branchId },
        snapshot: { snapshotId: prepared.snapshotId },
    });
}
