import type { PreviewDeployTarget } from "@autonoma/types";
import { log, proxyActivities } from "@temporalio/workflow";
import type { PreviewBuildWarrantReason, PreviewkitActivities } from "../activities";
import { previewIds } from "../observability/preview-ids";
import { rootFailureMessage } from "../root-failure-message";
import { warrantsBuild } from "../rules/build-warrant";
import { TaskQueue } from "../task-queues";

const previewkitReads = proxyActivities<Pick<PreviewkitActivities, "reportPreviewBuildWarrant">>({
    startToCloseTimeout: "1m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.GENERAL,
});

export interface PreviewBuildWarrant {
    target: PreviewDeployTarget;
    /** The run reports only its refusals; every build reports its own approval. */
    reason: PreviewBuildWarrantReason;
    branchId?: string;
    snapshotId?: string;
    /** How many tests the selection picked, when a selection is what decided this. */
    targetCount?: number;
}

/**
 * Record why this commit is or is not getting a preview.
 *
 * Never allowed to fail the flow: observability must not decide whether a customer gets a preview.
 */
export async function reportBuildWarrant(verdict: PreviewBuildWarrant): Promise<void> {
    const { target, reason, branchId, snapshotId, targetCount } = verdict;
    log.info(warrantsBuild(reason) ? "Preview build warranted" : "Preview build not warranted", {
        ...previewIds(target),
        extra: { prNumber: target.prNumber, headSha: target.headSha, reason, targetCount },
    });

    try {
        await previewkitReads.reportPreviewBuildWarrant({
            organizationId: target.organizationId,
            repoFullName: target.repoFullName,
            prNumber: target.prNumber,
            headSha: target.headSha,
            branchId,
            snapshotId,
            reason,
            targetCount,
        });
    } catch (error) {
        log.warn("Failed to report the preview build warrant", {
            ...previewIds(target),
            extra: { reason, message: rootFailureMessage(error) },
        });
    }
}
