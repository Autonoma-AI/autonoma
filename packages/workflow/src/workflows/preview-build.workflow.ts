import type { ObservabilityContext } from "@autonoma/logger";
import type { PreviewDeployTarget } from "@autonoma/types";
import {
    ApplicationFailure,
    CancellationScope,
    isCancellation,
    log,
    proxyActivities,
    sleep,
} from "@temporalio/workflow";
import type { PreviewBuildWarrantReason, PreviewkitActivities, ReadPreviewBuildStatusOutput } from "../activities";
import { previewIds } from "../observability/preview-ids";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";
import { reportBuildWarrant } from "./report-build-warrant";

const BUILD_POLL_INTERVAL_MS = 30_000;
/**
 * Sits just above the runner Job's own 270-minute `activeDeadlineSeconds`, so the Job's own failure write is what
 * the poll observes rather than this backstop firing first.
 */
const BUILD_SETTLE_TIMEOUT_MINUTES = 285;
const BUILD_POLL_ATTEMPTS = Math.ceil((BUILD_SETTLE_TIMEOUT_MINUTES * 60_000) / BUILD_POLL_INTERVAL_MS);
/**
 * Generous next to pod scheduling and an image pull, but far short of the settle budget: a Job that dies before
 * its first write - evicted, OOM, image pull failure - would otherwise hold the flow open for hours.
 */
const BUILD_CLAIM_TIMEOUT_MINUTES = 30;
const BUILD_CLAIM_ATTEMPTS = Math.ceil((BUILD_CLAIM_TIMEOUT_MINUTES * 60_000) / BUILD_POLL_INTERVAL_MS);

// One attempt: a retried launch would kill the Job it just created.
const previewkit = proxyActivities<Pick<PreviewkitActivities, "launchPreviewBuild">>({
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

// These retry: the poll runs for hours and must survive a database blip, and a Job left running after an
// abandoned run is the exact cost this workflow exists to avoid.
const previewkitReads = proxyActivities<Pick<PreviewkitActivities, "readPreviewBuildStatus" | "cancelPreviewBuild">>({
    startToCloseTimeout: "1m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.GENERAL,
});

export interface PreviewBuildWorkflowInput {
    target: PreviewDeployTarget;
    reason: PreviewBuildWarrantReason;
    /** Present when an analysis run owns this build, so its warrant can be read alongside that run. */
    snapshotId?: string;
    branchId?: string;
}

export interface PreviewBuildWorkflowOutput {
    /** The origin the tests browse. */
    primaryUrl: string;
    /** Origin of the app hosting the Environment Factory handler, when the config declares one. */
    sdkAppUrl?: string;
}

/** Build one commit's preview environment and wait for it to come up. */
export async function previewBuildWorkflow(input: PreviewBuildWorkflowInput): Promise<PreviewBuildWorkflowOutput> {
    const { target, reason, snapshotId, branchId } = input;
    const ids = buildIds(input);
    log.info("Preview build started", { ...ids, extra: { headSha: target.headSha, reason } });

    await reportBuildWarrant({ target, reason, snapshotId, branchId });

    const { jobName } = await previewkit.launchPreviewBuild({ target });
    log.info("Preview build Job created", { ...ids, extra: { jobName } });

    try {
        return await awaitReadyPreview(target, ids);
    } catch (error) {
        if (isCancellation(error)) await cancelBuild(jobName, ids);
        throw error;
    }
}

/** The run that owns this build contributes the branch and snapshot. */
function buildIds({ target, snapshotId, branchId }: PreviewBuildWorkflowInput): ObservabilityContext {
    const ids = previewIds(target);
    if (branchId != null) ids.branch = { branchId };
    if (snapshotId != null) ids.snapshot = { snapshotId, headSha: target.headSha };
    return ids;
}

/** Poll to a terminal state, and insist that state is a usable preview. */
async function awaitReadyPreview(
    target: PreviewDeployTarget,
    ids: ObservabilityContext,
): Promise<PreviewBuildWorkflowOutput> {
    const settled = await awaitPreviewSettled(target, ids);

    if (settled.state !== "ready") {
        const detail = settled.error != null ? `: ${settled.error}` : "";
        throw noPreview(`Preview build settled as ${settled.state}${detail}`);
    }
    if (settled.primaryUrl == null) {
        // `ready` with nothing to browse almost always means the browsed app failed while its siblings came up.
        const cause = settled.error != null ? `: ${settled.error}` : "";
        throw noPreview(`Preview build is ready but exposes no primary URL${cause}`);
    }
    return { primaryUrl: settled.primaryUrl, sdkAppUrl: settled.sdkAppUrl };
}

/**
 * A plain `Error` thrown from workflow code fails the workflow TASK, which Temporal retries forever - the build
 * would wedge in `Running` instead of reporting that no preview is coming.
 */
function noPreview(message: string): ApplicationFailure {
    return ApplicationFailure.nonRetryable(message, "PreviewBuildFailed");
}

/**
 * A durable timer plus a cheap read: an activity waiting for hours holds a worker slot and dies with a deploy.
 * Two budgets, because a build stalls two ways - never claiming the environment, or claiming and never settling.
 */
async function awaitPreviewSettled(
    target: PreviewDeployTarget,
    ids: ObservabilityContext,
): Promise<ReadPreviewBuildStatusOutput> {
    let claimed = false;
    for (let attempt = 1; attempt <= BUILD_POLL_ATTEMPTS; attempt += 1) {
        await sleep(BUILD_POLL_INTERVAL_MS);
        const status = await previewkitReads.readPreviewBuildStatus({
            repoFullName: target.repoFullName,
            prNumber: target.prNumber,
            headSha: target.headSha,
        });

        if (status.state === "missing") {
            if (!claimed && attempt >= BUILD_CLAIM_ATTEMPTS) {
                throw noPreview(`Preview build did not start within ${BUILD_CLAIM_TIMEOUT_MINUTES} minutes`);
            }
            continue;
        }

        claimed = true;
        if (status.state === "building") continue;

        log.info("Preview build settled", { ...ids, extra: { state: status.state, attempt } });
        return status;
    }
    throw noPreview(`Preview build did not settle within ${BUILD_SETTLE_TIMEOUT_MINUTES} minutes`);
}

/**
 * Uncancellable: this runs BECAUSE the workflow was cancelled, so a cancellable scope would abort it before it
 * reached Kubernetes. Never rethrows - a throw would replace the cancellation with a misleading failure.
 */
async function cancelBuild(jobName: string, ids: ObservabilityContext): Promise<void> {
    log.info("Preview build cancelled; stopping its Job", { ...ids, extra: { jobName } });
    try {
        await CancellationScope.nonCancellable(() => previewkitReads.cancelPreviewBuild({ jobName }));
    } catch (error) {
        log.warn("Failed to stop the cancelled preview build's Job", {
            ...ids,
            extra: { jobName, message: rootFailureMessage(error) },
        });
    }
}
