import { CancellationScope, isCancellation, log, proxyActivities } from "@temporalio/workflow";
import type { PreviewDeployEvent, PreviewkitActivities } from "../activities";
import { rootFailureMessage } from "../root-failure-message";
import { TaskQueue } from "../task-queues";

/**
 * Short, GitHub-facing lifecycle activities (resolve + namespace + initial
 * comment/status). No heartbeat. Patient retry: when a PR is closed and
 * reopened within seconds, the reopen's prepare can race the namespace still
 * Terminating from the teardown - the spaced attempts ride that window out.
 */
const lifecycle = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "10m",
    retry: { maximumAttempts: 5, initialInterval: "5s" },
    taskQueue: TaskQueue.PREVIEWKIT,
});

/**
 * Long-running build + deploy. Heartbeated so a stuck/killed worker is
 * detected within `heartbeatTimeout` and the activity reschedules.
 */
const heavy = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.PREVIEWKIT,
});

/**
 * GitHub side effects that must happen (comment, commit status, deployment +
 * deployment status that triggers diffs). Retried more aggressively than the
 * rest because "this needs to land" is the whole point of moving them onto
 * Temporal.
 */
const feedback = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "10m",
    retry: { maximumAttempts: 5 },
    taskQueue: TaskQueue.PREVIEWKIT,
});

/**
 * Activities that must run even though the workflow scope is already cancelled
 * (the supersede cleanup). Same retry policy as `feedback`; `proxyActivities`
 * created in a non-cancellable scope is not auto-cancelled.
 */
const cleanup = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "10m",
    retry: { maximumAttempts: 5 },
    taskQueue: TaskQueue.PREVIEWKIT,
});

export interface PreviewDeployWorkflowInput {
    event: PreviewDeployEvent;
    /** Pin the config revision to reproduce a redeploy's original topology. */
    configRevisionId?: string | undefined;
}

export async function previewDeployWorkflow(input: PreviewDeployWorkflowInput): Promise<void> {
    const { event, configRevisionId } = input;
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber, sha: event.headSha.slice(0, 7) } };

    log.info("Preview deploy workflow started", ids);

    const prep = await lifecycle.preparePreviewDeploy({ event, configRevisionId });
    if (prep.skipped) {
        log.info("Preview deploy skipped (repo not linked or no .preview.yaml)", ids);
        return;
    }

    try {
        const built = await heavy.buildPreviewImages({ event, namespace: prep.namespace, configRevisionId });
        log.info("Preview images built", { extra: { ...ids.extra, apps: Object.keys(built.imageTags).length } });

        const deployed = await heavy.deployPreviewEnvironment({
            event,
            namespace: prep.namespace,
            commentId: prep.commentId,
            mergedConfigJson: built.mergedConfigJson,
            imageTags: built.imageTags,
            addonOutputs: built.addonOutputs,
            buildOutcomes: built.buildOutcomes,
            addons: built.addons,
            warnings: built.warnings,
            primaryAppNames: built.primaryAppNames,
        });
        log.info("Preview environment deployed", {
            extra: { ...ids.extra, readyCount: deployed.readyCount, totalCount: deployed.totalCount },
        });

        await feedback.finalizePreviewDeploy({
            event,
            namespace: prep.namespace,
            commentId: prep.commentId,
            feedbackEnabled: prep.feedbackEnabled,
            result: deployed,
        });

        log.info("Preview deploy workflow completed", ids);
    } catch (err) {
        // A cancellation means a newer commit superseded this run (or the PR was
        // closed). The successor run owns the environment row, so we must NOT
        // write it (no "failed" status, no failure PR comment) - we only
        // finalize this run's own build row. Run it non-cancellably because the
        // scope is already cancelled, then re-throw so the run ends `Cancelled`.
        if (isCancellation(err)) {
            log.info("Preview deploy superseded; finalizing build row only", ids);
            await CancellationScope.nonCancellable(() =>
                cleanup.markPreviewDeploySuperseded({ event, namespace: prep.namespace }),
            );
            throw err;
        }

        const message = rootFailureMessage(err);
        log.error("Preview deploy workflow failed; running failure finalizer", { extra: { ...ids.extra, message } });
        await feedback.failPreviewDeploy({
            event,
            namespace: prep.namespace,
            commentId: prep.commentId,
            feedbackEnabled: prep.feedbackEnabled,
            error: message,
        });
        throw err;
    }
}
