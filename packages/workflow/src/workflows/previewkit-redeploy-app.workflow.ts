import { log, proxyActivities } from "@temporalio/workflow";
import type { PreviewDeployEvent, PreviewkitActivities } from "../activities";
import { TaskQueue } from "../task-queues";

/** Long-running build + deploy, scoped to one app. Same envelope as the full deploy's `heavy`. */
const heavy = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "30m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.PREVIEWKIT,
});

/** Pod re-roll + readiness wait. Quick, but heartbeated like teardown so a stuck worker reschedules. */
const restart = proxyActivities<PreviewkitActivities>({
    startToCloseTimeout: "10m",
    heartbeatTimeout: "2m",
    retry: { maximumAttempts: 3 },
    taskQueue: TaskQueue.PREVIEWKIT,
});

export type PreviewRedeployAppMode = "rebuild" | "restart";

export interface PreviewRedeployAppWorkflowInput {
    event: PreviewDeployEvent;
    /** The environment's namespace, resolved from the env row by the API trigger. */
    namespace: string;
    /** The single app to redeploy. */
    appName: string;
    /** `rebuild` re-builds the image then redeploys; `restart` re-rolls the running pods. */
    mode: PreviewRedeployAppMode;
    /** Pin the config revision so the rebuild reproduces the environment's deployed topology. */
    configRevisionId?: string | undefined;
}

/**
 * Redeploys a SINGLE app within a live preview environment, in isolation.
 *
 * Shares the deploy/teardown workflowId (`previewkit-{slug}-{pr}`), so it
 * supersedes any in-flight full deploy for the PR - the per-environment mutex.
 *
 * Deliberately leaner than {@link previewDeployWorkflow}: no `prepare` and no
 * `finalize`, so a per-app redeploy never posts/rewrites the PR comment, flips
 * the commit status, or re-triggers diffs. Build + deploy are scoped to the one
 * app (`appName`); siblings are left running untouched.
 *
 * No supersede-cleanup branch: a per-app rebuild writes no `PreviewkitBuild`
 * row (nothing to mark superseded) and the build/deploy steps record the target
 * app's own terminal `PreviewkitAppInstance` state, so a genuine failure needs
 * no env-level failure finalizer. Cancellation and failures propagate as-is -
 * the build activity aborts its own buildctl + releases the buildkit Job in its
 * `finally`, and the successor run owns the environment row.
 */
export async function previewRedeployAppWorkflow(input: PreviewRedeployAppWorkflowInput): Promise<void> {
    const { event, namespace, appName, mode, configRevisionId } = input;
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber, app: appName, mode } };

    log.info("Preview per-app redeploy workflow started", ids);

    if (mode === "restart") {
        await restart.restartPreviewApp({ event, namespace, appName });
        log.info("Preview per-app restart completed", ids);
        return;
    }

    const built = await heavy.buildPreviewImages({ event, namespace, configRevisionId, appName });
    log.info("Preview per-app image built", { extra: { ...ids.extra, built: Object.keys(built.imageTags) } });

    await heavy.deployPreviewEnvironment({
        event,
        namespace,
        commentId: "",
        mergedConfigJson: built.mergedConfigJson,
        imageTags: built.imageTags,
        addonOutputs: built.addonOutputs,
        buildOutcomes: built.buildOutcomes,
        addons: built.addons,
        warnings: built.warnings,
        primaryAppNames: built.primaryAppNames,
        appName,
    });
    log.info("Preview per-app redeploy completed", ids);
}
