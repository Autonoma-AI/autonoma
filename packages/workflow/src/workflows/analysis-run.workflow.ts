import type { ObservabilityContext } from "@autonoma/logger";
import type { PreviewDeployTarget } from "@autonoma/types";
import {
    type ChildWorkflowHandle,
    isCancellation,
    log,
    ParentClosePolicy,
    proxyActivities,
    startChild,
} from "@temporalio/workflow";
import type {
    AnalysisActivities,
    PreviewBuildWarrantReason,
    PreviewkitActivities,
    ResolvePreviewTargetOutput,
    RunImpactAnalysisOutput,
} from "../activities";
import { previewIds } from "../observability/preview-ids";
import { previewBuildWorkflowId } from "../preview-build-id";
import { rootFailureMessage } from "../root-failure-message";
import {
    unconditionalWarrant,
    warrantForJudgedHead,
    warrantFromSelection,
    warrantsBuild,
} from "../rules/build-warrant";
import { TaskQueue } from "../task-queues";
import { WORKFLOW_TYPE } from "../workflow-types";
import type { PreviewBuildWorkflowInput, PreviewBuildWorkflowOutput } from "./preview-build.workflow";
import { reportBuildWarrant } from "./report-build-warrant";
import { runAnalysisStages } from "./run-analysis-stages";
import { withAnalysisRunSettlement } from "./with-analysis-run-settlement";

const analysis = proxyActivities<Pick<AnalysisActivities, "openAnalysisRun" | "openMergeGate" | "runImpactAnalysis">>({
    startToCloseTimeout: "20m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.DIFFS,
});

// One attempt: a retried attach would record a second deployment for one preview.
const previewkit = proxyActivities<Pick<PreviewkitActivities, "attachPreviewDeployment">>({
    startToCloseTimeout: "5m",
    retry: { maximumAttempts: 1 },
    taskQueue: TaskQueue.GENERAL,
});

// Reads and the warrant report retry: indexed queries and observability, nothing worth protecting from a retry.
const previewkitReads = proxyActivities<
    Pick<PreviewkitActivities, "resolvePreviewTarget" | "hasBranchEverBuiltPreview" | "readPreviewBuildStatus">
>({
    startToCloseTimeout: "1m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.GENERAL,
});

type BuildHandle = ChildWorkflowHandle<(input: PreviewBuildWorkflowInput) => Promise<PreviewBuildWorkflowOutput>>;

export interface AnalysisRunWorkflowInput {
    branchId: string;
    headSha: string;
    /** Only used for a branch with no active snapshot yet - the PR base the trigger read from GitHub. */
    baseSha?: string;
}

/**
 * Impact Analysis is source-only, so it runs FIRST and its selection warrants the build. Every other case builds
 * unconditionally, ahead of opening the run: a customer owed a refresh gets it even if the pipeline fails.
 */
export async function analysisRunWorkflow(input: AnalysisRunWorkflowInput): Promise<void> {
    const { branchId, headSha, baseSha } = input;
    log.info("Analysis run started", { branch: { branchId }, extra: { headSha } });

    // Asked first: the answer decides whether there is a build to warrant at all, and names the branch's owner.
    const resolved = await previewkitReads.resolvePreviewTarget({ branchId, headSha });
    const { target } = resolved;
    const ids = runIds(branchId, resolved);

    // Refuse BEFORE opening the run: a snapshot would take this head as analyzed, and the customer's own trigger -
    // the only thing that can record their preview - would then be dropped as a duplicate, stranding the commit.
    if (target == null && !resolved.hasRecordedPreview) {
        log.info("Nothing to analyze against: the customer owns this preview and none is recorded yet", ids);
        return;
    }

    // An unconditional warrant starts the build here, ahead of opening the run: nothing
    // fallible may sit in front of a refresh the customer is entitled to.
    const eager = target != null ? await startEagerBuild(target, branchId, ids) : undefined;

    const run = await analysis.openAnalysisRun({ branchId, headSha, baseSha });
    if (run.skipped) {
        await settleSkippedRun({ target, eager, branchId, ids });
        return;
    }

    const snapshotId = run.snapshotId;
    const runScopedIds: ObservabilityContext = { ...ids, snapshot: { snapshotId, headSha } };

    await withAnalysisRunSettlement(snapshotId, runScopedIds, async () => {
        // Stage 0 - open the merge gate: for the auto-run-on-ready path (which reaches here without the API's
        // `requestAnalysisRun`), flip the un-requested `Autonoma` check to the in-progress "Analyzing" state and
        // stamp the activation. Self-skips for every other run.
        await analysis.openMergeGate({ snapshotId });

        // Reaching a selection may involve building the preview the Investigators run against - or deciding not to.
        const impact =
            target != null
                ? await impactWithPreview({ target, branchId, snapshotId, eager })
                : await runImpactAnalysis(snapshotId, runScopedIds);

        // An unwarranted build leaves `targets` empty, so the fan-out is a no-op.
        await runAnalysisStages(snapshotId, impact, runScopedIds);
    });
}

/** Who and what this run is about, as far as it is known before the snapshot exists. */
function runIds(branchId: string, resolved: ResolvePreviewTargetOutput): ObservabilityContext {
    const ids: ObservabilityContext = resolved.target != null ? previewIds(resolved.target) : {};
    ids.branch = { branchId };
    if (resolved.organizationId != null) ids.organization = { organizationId: resolved.organizationId };
    return ids;
}

/** The same ids once the run's snapshot exists. */
function snapshotIds(target: PreviewDeployTarget, snapshotId: string): ObservabilityContext {
    const ids = previewIds(target);
    ids.snapshot = { snapshotId, headSha: target.headSha };
    return ids;
}

/** Nothing to build, so the selection IS the run's work. */
async function runImpactAnalysis(snapshotId: string, ids: ObservabilityContext): Promise<RunImpactAnalysisOutput> {
    const impact = await analysis.runImpactAnalysis({ snapshotId });
    log.info("Impact Analysis complete", { ...ids, extra: { targetCount: impact.targets.length } });
    return impact;
}

/** Start the build now when the warrant is unconditional; otherwise defer until the selection is known. */
async function startEagerBuild(
    target: PreviewDeployTarget,
    branchId: string,
    ids: ObservabilityContext,
): Promise<BuildHandle | undefined> {
    // The one fact the rule needs that is not already in hand.
    const { everBuilt } = await previewkitReads.hasBranchEverBuiltPreview({ branchId });
    const reason = unconditionalWarrant({ prNumber: target.prNumber, everPreviewed: everBuilt });
    log.info("Preview build warrant evaluated", { ...ids, extra: { unconditional: reason != null, reason } });

    if (reason == null) return undefined;
    return await startBuild({ target, reason, branchId });
}

/**
 * A re-delivered trigger for a head already judged. Where the selection decides, honour the earlier verdict: re-judging
 * is impossible without a run, but whether a build was ever attempted for this commit is a fact.
 */
async function settleSkippedRun(params: {
    target?: PreviewDeployTarget;
    eager?: BuildHandle;
    branchId: string;
    ids: ObservabilityContext;
}): Promise<void> {
    const build = await buildOwnedBySkippedRun(params);
    if (build == null) return;
    await awaitStartedBuild(build, params.ids);
}

/**
 * The build this run is leaving behind, or undefined when it leaves none. Every branch that has one returns it
 * rather than awaiting in place, so a child can never be started down one path and abandoned by it.
 */
async function buildOwnedBySkippedRun(params: {
    target?: PreviewDeployTarget;
    eager?: BuildHandle;
    branchId: string;
    ids: ObservabilityContext;
}): Promise<BuildHandle | undefined> {
    const { target, eager, branchId, ids } = params;
    if (eager != null) {
        log.info("Analysis run skipped: it already started this head's build", ids);
        return eager;
    }
    if (target == null) {
        log.info("Analysis run skipped: head already analyzed", ids);
        return undefined;
    }

    const attempted = await previewkitReads.readPreviewBuildStatus({
        repoFullName: target.repoFullName,
        prNumber: target.prNumber,
        headSha: target.headSha,
    });
    const reason = warrantForJudgedHead(attempted.state !== "missing");
    if (!warrantsBuild(reason)) {
        await reportBuildWarrant({ target, branchId, reason });
        log.info("Not rebuilding an already-judged commit that was found unwarranted", ids);
        return undefined;
    }

    const restarted = await startBuild({ target, reason, branchId });
    log.info("Preview build restarted for an already-analyzed head", ids);
    return restarted;
}

/**
 * A child is `REQUEST_CANCEL`, so a run that closes over one cancels the build it just promised. Nothing here
 * consumes the URL, so the outcome is the child's own to record and a failure is logged rather than propagated.
 */
async function awaitStartedBuild(build: BuildHandle, ids: ObservabilityContext): Promise<void> {
    try {
        const built = await build.result();
        log.info("Preview build finished for a skipped run", { ...ids, extra: { primaryUrl: built.primaryUrl } });
    } catch (error) {
        if (isCancellation(error)) throw error;
        log.warn("Preview build failed for a skipped run", { ...ids, extra: { message: rootFailureMessage(error) } });
    }
}

/** Reach a selection on the previewkit path, building the preview when - and only when - it is warranted. */
function impactWithPreview(params: {
    target: PreviewDeployTarget;
    branchId: string;
    snapshotId: string;
    eager?: BuildHandle;
}): Promise<RunImpactAnalysisOutput> {
    const { target, branchId, snapshotId, eager } = params;
    return eager == null
        ? buildIfWarranted({ target, branchId, snapshotId })
        : concurrentBuild({ target, branchId, snapshotId, eager });
}

/** A branch with no preview yet: impact analysis first, and the build only if it selected test work. */
async function buildIfWarranted(params: {
    target: PreviewDeployTarget;
    branchId: string;
    snapshotId: string;
}): Promise<RunImpactAnalysisOutput> {
    const { target, branchId, snapshotId } = params;
    const impact = await impactAnalysisForWarrant({ target, branchId, snapshotId });
    const targetCount = impact.targets.length;
    const reason = warrantFromSelection(targetCount);

    if (!warrantsBuild(reason)) {
        await reportBuildWarrant({ target, branchId, snapshotId, reason, targetCount });
        log.info("Skipping the preview build: this diff needs no live environment", snapshotIds(target, snapshotId));
        return impact;
    }

    const handle = await startBuild({ target, reason, branchId, snapshotId, targetCount });
    await attachBuiltPreview({ handle, target, branchId, snapshotId });
    return impact;
}

/**
 * Fail closed: when impact analysis errors on a never-previewed branch we cannot tell whether the commit deserved
 * a preview, so it does not get one. The next push re-judges on its own diff.
 */
async function impactAnalysisForWarrant(params: {
    target: PreviewDeployTarget;
    branchId: string;
    snapshotId: string;
}): Promise<RunImpactAnalysisOutput> {
    const { target, branchId, snapshotId } = params;
    try {
        const impact = await analysis.runImpactAnalysis({ snapshotId });
        log.info("Impact Analysis complete", {
            ...snapshotIds(target, snapshotId),
            extra: { targetCount: impact.targets.length },
        });
        return impact;
    } catch (error) {
        // Fails closed via the reason: `analysis_indeterminate` is one of the refusing reasons.
        await reportBuildWarrant({ target, branchId, snapshotId, reason: "analysis_indeterminate" });
        throw error;
    }
}

/** The build started before this run's snapshot existed, so wait for it CONCURRENTLY with impact analysis. */
async function concurrentBuild(params: {
    target: PreviewDeployTarget;
    branchId: string;
    snapshotId: string;
    eager: BuildHandle;
}): Promise<RunImpactAnalysisOutput> {
    const { target, branchId, snapshotId, eager } = params;

    // allSettled, not all: a failed analysis must not abandon a preview the customer is entitled to.
    const [impact, build] = await Promise.allSettled([
        analysis.runImpactAnalysis({ snapshotId }),
        attachBuiltPreview({ handle: eager, target, branchId, snapshotId }),
    ]);

    // Build failure first: with no live preview the Investigators have nothing to run against.
    if (build.status === "rejected") throw build.reason;
    if (impact.status === "rejected") throw impact.reason;

    log.info("Impact Analysis complete", {
        ...snapshotIds(target, snapshotId),
        extra: { targetCount: impact.value.targets.length },
    });
    return impact.value;
}

/** Start this commit's build as a child of the run that decided to build it. */
async function startBuild(params: {
    target: PreviewDeployTarget;
    reason: PreviewBuildWarrantReason;
    branchId: string;
    snapshotId?: string;
    targetCount?: number;
}): Promise<BuildHandle> {
    const { target, reason, branchId, snapshotId, targetCount } = params;
    log.info("Starting the preview build", {
        ...previewIds(target),
        extra: { reason, targetCount, headSha: target.headSha, prNumber: target.prNumber },
    });
    return await startChild(WORKFLOW_TYPE.PREVIEW_BUILD, {
        workflowId: previewBuildWorkflowId(target),
        taskQueue: TaskQueue.GENERAL,
        // A newer push supersedes this run: the child is cancelled and SIGTERMs its Job rather than deploying
        // a preview for a commit nobody will test.
        parentClosePolicy: ParentClosePolicy.REQUEST_CANCEL,
        args: [{ target, reason, branchId, snapshotId }],
    });
}

/** Wait for the build, then record the URL the branch's tests will run against. */
async function attachBuiltPreview(params: {
    handle: BuildHandle;
    target: PreviewDeployTarget;
    branchId: string;
    snapshotId: string;
}): Promise<void> {
    const { handle, target, branchId, snapshotId } = params;
    const ids: ObservabilityContext = { ...snapshotIds(target, snapshotId), branch: { branchId } };

    const built = await handle.result();
    const attached = await previewkit.attachPreviewDeployment({
        branchId,
        organizationId: target.organizationId,
        url: built.primaryUrl,
        sdkAppUrl: built.sdkAppUrl,
    });
    log.info("Branch deployment attached to the ready preview", {
        ...ids,
        extra: { deploymentId: attached.deploymentId, url: built.primaryUrl, sdkAppUrl: built.sdkAppUrl },
    });
}
