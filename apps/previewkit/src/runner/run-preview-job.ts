import type {
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    PreviewDeployEvent,
} from "@autonoma/types";
import * as Sentry from "@sentry/node";
import { PreviewPlatformError } from "../errors";
import type { PullRequestEvent } from "../git-provider/git-provider";
import { logger as rootLogger, type Logger } from "../logger";
import type { PreparePreviewResult } from "../pipeline/preview-pipeline";
import type { PreviewJobSpec } from "./job-spec";

// Shown to the user in place of a raw infra error (which they can't act on).
// The real detail is logged fatal for us - see the PreviewPlatformError branch below.
const PLATFORM_ERROR_USER_MESSAGE =
    "Something went wrong on Autonoma's side while deploying your preview. Our team has been notified and is looking into it - please try again shortly.";

/**
 * The slice of `PreviewPipeline` the runner drives. `PreviewPipeline` satisfies
 * this structurally, so the runner depends on the seam (not the concrete class
 * with its heavy collaborators) and tests pass a lightweight fake.
 */
export interface DeployPipeline {
    prepare(event: PullRequestEvent): Promise<PreparePreviewResult>;
    build(
        event: PullRequestEvent,
        namespace: string,
        signal?: AbortSignal,
        appName?: string,
    ): Promise<BuildPreviewImagesOutput>;
    deployEnvironment(
        input: DeployPreviewEnvironmentInput,
        signal?: AbortSignal,
    ): Promise<DeployPreviewEnvironmentOutput>;
    finalize(
        event: PullRequestEvent,
        namespace: string,
        commentId: string,
        feedbackEnabled: boolean,
        result: DeployPreviewEnvironmentOutput,
    ): Promise<void>;
    fail(
        event: PullRequestEvent,
        namespace: string,
        commentId: string,
        feedbackEnabled: boolean,
        error: string,
    ): Promise<void>;
    restartApp(event: PullRequestEvent, namespace: string, appName: string, signal?: AbortSignal): Promise<void>;
}

/** The slice of `TeardownPipeline` the runner drives. */
export interface TeardownRunner {
    teardown(event: PullRequestEvent): Promise<void>;
}

export interface PreviewJobRunners {
    previewPipeline: DeployPipeline;
    teardownPipeline: TeardownRunner;
}

/**
 * The DB-touching side effects, injected so the orchestration here stays a pure
 * unit (no `@autonoma/db` import) - the entry point wires the real
 * implementations (see `./deps`), tests pass fakes.
 */
export interface RunPreviewJobDeps {
    /** Finalize only the superseded run's build row (never the env row). */
    markSuperseded: (namespace: string, headSha: string) => Promise<void>;
    /** Resolve the deployed-commit sha for a teardown whose event has none. */
    resolveTeardownHeadSha: (event: PreviewDeployEvent) => Promise<PreviewDeployEvent>;
    /**
     * Start the diffs run (as a Temporal job) once a PR preview env is ready. The impl applies its own guards
     * (Temporal unconfigured, main env 0, no branchId, not ready, no primary url) and may throw - `runDeploy`
     * isolates it so a failure never flips the already-`ready` outcome.
     */
    triggerDiffs: (event: PreviewDeployEvent, result: DeployPreviewEnvironmentOutput) => Promise<void>;
}

/**
 * Terminal outcome of one preview job. Every outcome here is *handled* - the DB
 * and PR comment are left in a consistent terminal state - so the runner exits
 * 0 for all of them. Only an unexpected throw (e.g. `prepare` failing, or the
 * failure finalizer itself failing) propagates and exits non-zero, letting the
 * Job's `backoffLimit` retry a genuinely crashed attempt.
 */
export type PreviewJobOutcome =
    | "ready"
    | "deploy_failed"
    | "finalize_failed"
    | "superseded"
    | "skipped"
    | "torn_down"
    | "redeployed"
    | "restarted"
    | "redeploy_failed";

/**
 * Runs one preview deploy or teardown to completion - the Temporal-free
 * re-implementation of `previewDeployWorkflow` / `previewTeardownWorkflow`. The
 * workflow's linear activity sequence collapses into direct pipeline calls in a
 * single process, and the workflow's `isCancellation()` branch becomes the
 * `signal.aborted` (SIGTERM = supersede) branch.
 */
export async function runPreviewJob(
    runners: PreviewJobRunners,
    spec: PreviewJobSpec,
    signal: AbortSignal,
    deps: RunPreviewJobDeps,
): Promise<PreviewJobOutcome> {
    const logger = rootLogger.child({ name: "runPreviewJob" });
    if (spec.mode === "teardown") {
        return await runTeardown(runners.teardownPipeline, spec.event, deps, logger);
    }
    if (spec.mode === "redeploy-app") {
        return await runRedeployApp(runners.previewPipeline, spec, signal, logger);
    }
    return await runDeploy(runners.previewPipeline, spec.event, signal, deps, logger);
}

async function runDeploy(
    previewPipeline: DeployPipeline,
    event: PreviewDeployEvent,
    signal: AbortSignal,
    deps: RunPreviewJobDeps,
    logger: Logger,
): Promise<PreviewJobOutcome> {
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber, sha: event.headSha.slice(0, 7) } };

    // Prepare runs before the try, mirroring the workflow: a prepare failure
    // means config/namespace could not be resolved, so there is nothing to
    // finalize - let it propagate (non-zero exit) so the Job retries.
    const prep = await previewPipeline.prepare(event);
    if (prep.skipped) {
        logger.info("Preview deploy skipped (repo not linked or no preview config)", ids);
        return "skipped";
    }

    let deployed: DeployPreviewEnvironmentOutput | undefined;
    try {
        const built = await previewPipeline.build(event, prep.namespace, signal);
        logger.info("Preview images built", { extra: { ...ids.extra, apps: Object.keys(built.imageTags).length } });

        const deployInput: DeployPreviewEnvironmentInput = {
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
        };
        deployed = await previewPipeline.deployEnvironment(deployInput, signal);
        logger.info("Preview environment deployed", {
            extra: { ...ids.extra, readyCount: deployed.readyCount, totalCount: deployed.totalCount },
        });

        await previewPipeline.finalize(event, prep.namespace, prep.commentId, prep.feedbackEnabled, deployed);

        // Start the diffs run now the env is ready. Isolated: the environment is already persisted `ready`, so a
        // failed trigger must not reach the outer catch (which, with a non-null `deployed`, would mislabel the
        // outcome `finalize_failed`).
        try {
            await deps.triggerDiffs(event, deployed);
        } catch (err) {
            Sentry.captureException(err);
            logger.error("Failed to trigger diffs after deploy; leaving environment ready", {
                extra: { ...ids.extra, message: errorMessage(err) },
            });
        }

        logger.info("Preview deploy completed", ids);
        return "ready";
    } catch (err) {
        // SIGTERM aborts the in-flight build/deploy. Like the workflow's
        // isCancellation() branch, a supersede must NOT touch the environment
        // row (the successor run owns it) - finalize only this run's build row.
        if (signal.aborted) {
            logger.info("Preview deploy superseded; finalizing build row only", ids);
            await deps.markSuperseded(prep.namespace, event.headSha);
            return "superseded";
        }

        // A genuine failure. The workflow re-threw to surface the run as failed;
        // here the Job exits 0 after recording a terminal state, so capture
        // explicitly for alerting instead of relying on an uncaught throw.
        const isPlatformError = err instanceof PreviewPlatformError;
        Sentry.captureException(err, isPlatformError ? { level: "fatal" } : undefined);
        const message = errorMessage(err);

        // Once deployEnvironment returns, the environment row is persisted
        // `ready`; a later finalize failure is best-effort GitHub feedback, not
        // an environment failure, so we must not stamp it `failed`.
        if (deployed == null) {
            if (isPlatformError) {
                // An Autonoma infra/control-plane failure the user can't act on.
                // Log it fatal with the raw detail for us; record a generic message
                // so the customer-facing status never carries raw cluster internals.
                logger.fatal("Preview deploy hit a platform error", { extra: { ...ids.extra, message } });
                await previewPipeline.fail(
                    event,
                    prep.namespace,
                    prep.commentId,
                    prep.feedbackEnabled,
                    PLATFORM_ERROR_USER_MESSAGE,
                );
                return "deploy_failed";
            }
            logger.error("Preview deploy failed; running failure finalizer", { extra: { ...ids.extra, message } });
            await previewPipeline.fail(event, prep.namespace, prep.commentId, prep.feedbackEnabled, message);
            return "deploy_failed";
        }
        logger.error("Preview finalize failed after a successful deploy; leaving environment ready", {
            extra: { ...ids.extra, message },
        });
        return "finalize_failed";
    }
}

async function runTeardown(
    teardownPipeline: TeardownRunner,
    event: PreviewDeployEvent,
    deps: RunPreviewJobDeps,
    logger: Logger,
): Promise<PreviewJobOutcome> {
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber } };
    logger.info("Tearing down preview environment", ids);
    const resolvedEvent = await deps.resolveTeardownHeadSha(event);
    await teardownPipeline.teardown(resolvedEvent);
    logger.info("Preview environment torn down", ids);
    return "torn_down";
}

/**
 * Re-implementation of `previewRedeployAppWorkflow` for a single app, scoped to
 * the namespace the API resolved from the env row. Leaner than a full deploy:
 * no `prepare` and no `finalize`, so it never posts the PR comment, flips the
 * commit status, or re-triggers diffs - and there is no supersede-cleanup (a
 * per-app run writes no `PreviewkitBuild` row; build/deploy record the target
 * app's own terminal `PreviewkitAppInstance` state).
 */
async function runRedeployApp(
    previewPipeline: DeployPipeline,
    spec: Extract<PreviewJobSpec, { mode: "redeploy-app" }>,
    signal: AbortSignal,
    logger: Logger,
): Promise<PreviewJobOutcome> {
    const { event, namespace, appName, redeployMode } = spec;
    const ids = { extra: { repo: event.repoFullName, pr: event.prNumber, app: appName, mode: redeployMode } };
    try {
        if (redeployMode === "restart") {
            await previewPipeline.restartApp(event, namespace, appName, signal);
            logger.info("Preview per-app restart completed", ids);
            return "restarted";
        }
        const built = await previewPipeline.build(event, namespace, signal, appName);
        const deployInput: DeployPreviewEnvironmentInput = {
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
        };
        await previewPipeline.deployEnvironment(deployInput, signal);
        logger.info("Preview per-app redeploy completed", ids);
        return "redeployed";
    } catch (err) {
        // Supersede: a newer deploy/redeploy/teardown aborted this run. There is
        // no build row to mark and the successor owns the env, so just exit clean.
        if (signal.aborted) {
            logger.info("Preview per-app redeploy superseded", ids);
            return "superseded";
        }
        // Genuine failure: build/deploy already recorded the app's terminal
        // PreviewkitAppInstance state, so there is no env-level finalizer - capture
        // for alerting and exit 0 (handled).
        Sentry.captureException(err);
        logger.error("Preview per-app redeploy failed", { extra: { ...ids.extra, message: errorMessage(err) } });
        return "redeploy_failed";
    }
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
