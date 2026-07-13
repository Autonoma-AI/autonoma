import { runWithSentry } from "@autonoma/logger";
import type { PreviewDeployEvent } from "@autonoma/types";
import { createPreviewkitServices } from "../create-services";
import { env } from "../env";
import { logger, type PreviewContext, withObservabilityContext } from "../logger";
import { defaultRunPreviewJobDeps } from "./deps";
import { parseJobSpec, type PreviewJobSpec } from "./job-spec";
import { runPreviewJob } from "./run-preview-job";

/**
 * One-shot entrypoint for a preview deploy/teardown Kubernetes Job (the Jobs
 * replacement for the Temporal worker + workflow). It reads its single
 * PREVIEWKIT_JOB_SPEC payload, builds the same `PreviewkitServices` the worker
 * built, runs the pipeline once, and exits. `runWithSentry` owns the exit code:
 * a normal return exits 0 (every *handled* outcome, including a recorded
 * failure or a supersede), while an uncaught throw exits non-zero so the Job's
 * backoffLimit retries a genuinely crashed attempt.
 */
void runWithSentry({ name: "previewkit-runner", dsn: env.SENTRY_DSN }, async () => {
    const spec = parseJobSpec(env.PREVIEWKIT_JOB_SPEC);
    logger.info("Preview job runner started", {
        extra: {
            mode: spec.mode,
            repo: spec.event.repoFullName,
            pr: spec.event.prNumber,
            sha: spec.event.headSha.slice(0, 7),
        },
    });

    const services = await createPreviewkitServices();
    const abortController = new AbortController();
    installSignalHandler(spec, abortController);

    try {
        const outcome = await withObservabilityContext({ preview: previewContext(spec.event) }, () =>
            runPreviewJob(services, spec, abortController.signal, defaultRunPreviewJobDeps),
        );
        logger.info("Preview job runner finished", { extra: { mode: spec.mode, outcome } });
    } finally {
        // Retry cleanup for any child buildkitd Job whose per-build finally
        // block could not delete it. The Job deadline remains the last-resort
        // backstop if the control-cluster API is unavailable during shutdown.
        await services.buildkitJobManager?.releaseAll().catch((err: unknown) => {
            const cleanupError = err instanceof Error ? err : new Error(String(err));
            logger.error("Failed to release all buildkit Jobs on shutdown", cleanupError, {
                extra: { mode: spec.mode },
            });
        });
        // Drain the batched build-log sink so the tail of an in-flight build is
        // not lost when runWithSentry calls process.exit. Mirrors the worker's
        // shutdown drain.
        await services.buildLogSink?.close?.().catch((err: unknown) => {
            logger.warn("Failed to drain build-log sink on shutdown", { extra: { err } });
        });
    }
});

/**
 * Deploy and per-app redeploy jobs treat SIGTERM as a supersede: abort the
 * in-flight build/deploy so buildctl is killed in seconds, then the run takes
 * its supersede branch. Teardown jobs deliberately
 * ignore SIGTERM and run the (idempotent) namespace deletion to completion - a
 * half-deleted namespace is worse than a slightly longer shutdown. This is the
 * Jobs equivalent of the workflow's nonCancellable teardown scope; the pod's
 * terminationGracePeriodSeconds bounds both.
 */
function installSignalHandler(spec: PreviewJobSpec, abortController: AbortController): void {
    if (spec.mode === "teardown") {
        process.once("SIGTERM", () => {
            logger.warn("SIGTERM received during teardown; ignoring to finish namespace deletion");
        });
        return;
    }
    process.once("SIGTERM", () => {
        logger.warn("SIGTERM received; aborting run (superseded)", { extra: { mode: spec.mode } });
        abortController.abort(new Error("preview run superseded by SIGTERM"));
    });
}

function previewContext(event: PreviewDeployEvent): PreviewContext {
    return { repo: event.repoFullName, headRef: event.headRef === "" ? undefined : event.headRef };
}
