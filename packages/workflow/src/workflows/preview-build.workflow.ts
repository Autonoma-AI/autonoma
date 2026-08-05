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
import type {
    PreviewBuildJobState,
    PreviewBuildWarrantReason,
    PreviewkitActivities,
    ReadPreviewBuildStatusOutput,
} from "../activities";
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
 * Only for a Job that never reports an end at all - one deleted from under us, or reads that keep failing. A Job
 * that dies visibly is caught by its own terminal state long before this.
 */
const BUILD_CLAIM_TIMEOUT_MINUTES = 30;
const BUILD_CLAIM_ATTEMPTS = Math.ceil((BUILD_CLAIM_TIMEOUT_MINUTES * 60_000) / BUILD_POLL_INTERVAL_MS);

const PREVIEW_BUILD_FAILED = "PreviewBuildFailed";
const PREVIEW_BUILD_DECLINED = "PreviewBuildDeclined";

// One attempt: a retried launch would kill the Job it just created.
const previewkit = proxyActivities<Pick<PreviewkitActivities, "launchPreviewBuild">>({
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

// These retry: the poll runs for hours and must survive a database blip, and a Job left running after an
// abandoned run is the exact cost this workflow exists to avoid.
const previewkitReads = proxyActivities<
    Pick<PreviewkitActivities, "readPreviewBuildStatus" | "readPreviewBuildJobState" | "cancelPreviewBuild">
>({
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

    const launch = await previewkit.launchPreviewBuild({ target });
    if (launch.declined != null) {
        log.info("Preview build declined before a Job was created", { ...ids, extra: { declined: launch.declined } });
        throw noPreviewComing(launch.declined);
    }
    const { jobName } = launch;
    log.info("Preview build Job created", { ...ids, extra: { jobName } });

    try {
        return await awaitReadyPreview(target, jobName, ids);
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
    jobName: string,
    ids: ObservabilityContext,
): Promise<PreviewBuildWorkflowOutput> {
    const settled = await awaitPreviewSettled(target, jobName, ids);

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
    return ApplicationFailure.nonRetryable(message, PREVIEW_BUILD_FAILED);
}

/** Its own failure type, so a commit that was never getting a preview is not counted as a build that broke. */
function noPreviewComing(reason: string): ApplicationFailure {
    return ApplicationFailure.nonRetryable(`No preview was built: ${reason}`, PREVIEW_BUILD_DECLINED);
}

/**
 * A durable timer plus cheap reads: an activity waiting for hours holds a worker slot and dies with a deploy.
 * Two budgets, because a build stalls two ways - never claiming the environment, or claiming and never settling.
 */
async function awaitPreviewSettled(
    target: PreviewDeployTarget,
    jobName: string,
    ids: ObservabilityContext,
): Promise<ReadPreviewBuildStatusOutput> {
    let claimed = false;
    for (let attempt = 1; attempt <= BUILD_POLL_ATTEMPTS; attempt += 1) {
        await sleep(BUILD_POLL_INTERVAL_MS);

        // Read the Job BEFORE the status: one that had already ended cannot have written a row between the two,
        // so `missing` below is final. The other order calls a build dead that had just come to life.
        const ended = claimed ? undefined : await endedWithoutClaiming(jobName, ids);

        const status = await previewkitReads.readPreviewBuildStatus({
            repoFullName: target.repoFullName,
            prNumber: target.prNumber,
            headSha: target.headSha,
        });

        if (status.state === "missing") {
            if (ended != null) {
                log.info("Preview build ended without claiming the environment", {
                    ...ids,
                    extra: { attempt, outcome: ended.type, reason: ended.message },
                });
                throw ended;
            }
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
 * What a stopped Job means for this commit, or undefined while it might still write a status.
 *
 * The exit code decides which kind it is, and it is not ambiguous: the runner exits 0 for every outcome it HANDLED,
 * declining to deploy included, so `succeeded` is the refusal and a `Failed` Job is two non-zero exits - a crash
 * that broke a preview somebody was owed (an unparseable stored config, an evicted pod, an image it cannot pull).
 */
async function endedWithoutClaiming(
    jobName: string,
    ids: ObservabilityContext,
): Promise<ApplicationFailure | undefined> {
    const state = await readJobState(jobName, ids);
    switch (state) {
        case "running":
            return undefined;
        case "succeeded":
            return noPreviewComing("the deploy declined to build a preview for this commit");
        case "failed":
            return noPreview("Preview build Job died before it recorded anything");
        // Nothing broke and nothing is coming: in practice a teardown or per-app redeploy took the environment's
        // mutex, which supersedes the in-flight deploy Job without cancelling this workflow.
        case "gone":
            return noPreviewComing("the deploy Job is gone - cancelled, or superseded by a newer deploy");
    }
}

/** An unreadable Job is not a dead one: this read exists to shorten a failure, never to cause one. */
async function readJobState(jobName: string, ids: ObservabilityContext): Promise<PreviewBuildJobState> {
    try {
        const { state } = await previewkitReads.readPreviewBuildJobState({ jobName });
        return state;
    } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("Could not read the preview build Job's state; assuming it is still running", {
            ...ids,
            extra: { jobName, message: rootFailureMessage(error) },
        });
        return "running";
    }
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
