import { db } from "@autonoma/db";
import type {
    BuildPreviewImagesInput,
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    FailPreviewDeployInput,
    FinalizePreviewDeployInput,
    MarkPreviewDeploySupersededInput,
    PreparePreviewDeployInput,
    PreparePreviewDeployOutput,
    PreviewDeployEvent,
    PreviewkitActivities,
    TeardownPreviewEnvironmentInput,
} from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { createPreviewkitServices, type PreviewkitServices } from "../create-services";
import { markBuildSuperseded } from "../db";
import { type Logger, type PreviewContext, extendObservabilityContext, logger as rootLogger } from "../logger";

/**
 * Lazily-built singleton of the heavy services (k8s clients, builder, GitHub
 * app, AWS). Built once per worker process and shared across activity
 * invocations - mirrors how the HTTP server builds them once at boot.
 */
let servicesPromise: Promise<PreviewkitServices> | undefined;
export function getServices(): Promise<PreviewkitServices> {
    servicesPromise ??= createPreviewkitServices();
    return servicesPromise;
}

/**
 * Heartbeat every 10s. Two purposes: a stuck/killed worker is detected within
 * the activity's `heartbeatTimeout` (2m) and rescheduled; and Temporal delivers
 * an inbound cancellation to a long-running activity only on a heartbeat
 * response, so a tight interval bounds how fast a supersede aborts the build.
 */
function startHeartbeat(): NodeJS.Timeout {
    return setInterval(() => Context.current().heartbeat(), 10_000);
}

/**
 * Canonical observability fields for a preview deploy. Setting these once at the
 * top of each activity threads the repo and the git branch (`headRef`) through
 * every `logger.*` call the activity makes - clone, build, deploy, finalize - so
 * a deployment's logs stay filterable by branch end to end without re-passing
 * them at each call site. `headRef` is omitted on close events (empty ref).
 */
function previewContext(event: PreviewDeployEvent): PreviewContext {
    return {
        repo: event.repoFullName,
        headRef: event.headRef === "" ? undefined : event.headRef,
    };
}

export async function preparePreviewDeploy(input: PreparePreviewDeployInput): Promise<PreparePreviewDeployOutput> {
    const logger = rootLogger.child({ name: "preparePreviewDeploy" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Preparing preview deploy", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const { previewPipeline } = await getServices();
    const result = await previewPipeline.prepare(input.event, input.configRevisionId);
    if (result.skipped) {
        return { skipped: true, namespace: "", commentId: "", feedbackEnabled: false };
    }
    return {
        skipped: false,
        namespace: result.namespace,
        commentId: result.commentId,
        feedbackEnabled: result.feedbackEnabled,
    };
}

export async function buildPreviewImages(input: BuildPreviewImagesInput): Promise<BuildPreviewImagesOutput> {
    const logger = rootLogger.child({ name: "buildPreviewImages" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Building preview images", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const heartbeat = startHeartbeat();
    try {
        const { previewPipeline } = await getServices();
        // `cancellationSignal` aborts the in-flight buildctl when a newer commit
        // supersedes this run, so the buildkit Job is released in seconds.
        return await previewPipeline.build(
            input.event,
            input.namespace,
            input.configRevisionId,
            Context.current().cancellationSignal,
        );
    } finally {
        clearInterval(heartbeat);
    }
}

export async function deployPreviewEnvironment(
    input: DeployPreviewEnvironmentInput,
): Promise<DeployPreviewEnvironmentOutput> {
    const logger = rootLogger.child({ name: "deployPreviewEnvironment" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Deploying preview environment", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const heartbeat = startHeartbeat();
    try {
        const { previewPipeline } = await getServices();
        return await previewPipeline.deployEnvironment(input, Context.current().cancellationSignal);
    } finally {
        clearInterval(heartbeat);
    }
}

export async function finalizePreviewDeploy(input: FinalizePreviewDeployInput): Promise<void> {
    const logger = rootLogger.child({ name: "finalizePreviewDeploy" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Finalizing preview deploy", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const { previewPipeline } = await getServices();
    await previewPipeline.finalize(input.event, input.namespace, input.commentId, input.feedbackEnabled, input.result);
}

export async function failPreviewDeploy(input: FailPreviewDeployInput): Promise<void> {
    const logger = rootLogger.child({ name: "failPreviewDeploy" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Running preview deploy failure finalizer", {
        repo: input.event.repoFullName,
        pr: input.event.prNumber,
    });

    const { previewPipeline } = await getServices();
    await previewPipeline.fail(input.event, input.namespace, input.commentId, input.feedbackEnabled, input.error);
}

export async function teardownPreviewEnvironment(input: TeardownPreviewEnvironmentInput): Promise<void> {
    const logger = rootLogger.child({ name: "teardownPreviewEnvironment" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Tearing down preview environment", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const heartbeat = startHeartbeat();
    try {
        const { teardownPipeline } = await getServices();
        const event = await resolveTeardownHeadSha(input.event, logger);
        await teardownPipeline.teardown(event);
    } finally {
        clearInterval(heartbeat);
    }
}

/**
 * Webhook close events arrive with `headSha: ""` - fall back to the
 * environment row's stored sha so the teardown commit status lands on the
 * commit that was actually deployed.
 */
async function resolveTeardownHeadSha(event: PreviewDeployEvent, logger: Logger): Promise<PreviewDeployEvent> {
    if (event.headSha !== "") return event;

    const row = await db.previewkitEnvironment
        .findUnique({
            where: { repoFullName_prNumber: { repoFullName: event.repoFullName, prNumber: event.prNumber } },
            select: { headSha: true },
        })
        .catch((err: unknown) => {
            logger.warn("Failed to look up environment headSha for teardown; proceeding without it", {
                repo: event.repoFullName,
                pr: event.prNumber,
                err,
            });
            return null;
        });
    if (row == null) return event;

    return { ...event, headSha: row.headSha };
}

/**
 * Activity run from `previewDeployWorkflow`'s cancellation branch when a newer
 * commit (or a teardown) supersedes the in-flight deploy. Its whole job is to
 * leave the DB in a clean terminal state for the run that just got cancelled.
 *
 * It deliberately finalizes ONLY this run's own build row (delegating to the
 * `markBuildSuperseded` DB write) and never touches the environment
 * row: the superseding run reuses the same namespace and starts immediately, so
 * it owns the env row - writing it here would race and clobber the successor's
 * status. That ownership rule is why this is a separate activity rather than a
 * branch inside `failPreviewDeploy`, which *does* write the env row.
 */
export async function markPreviewDeploySuperseded(input: MarkPreviewDeploySupersededInput): Promise<void> {
    const logger = rootLogger.child({ name: "markPreviewDeploySuperseded" });
    extendObservabilityContext({ preview: previewContext(input.event) });
    logger.info("Marking preview deploy superseded", {
        repo: input.event.repoFullName,
        pr: input.event.prNumber,
    });
    await markBuildSuperseded(input.namespace, input.event.headSha);
}

// Compile-time check: ensure exported activities match the PreviewkitActivities contract.
({
    preparePreviewDeploy,
    buildPreviewImages,
    deployPreviewEnvironment,
    finalizePreviewDeploy,
    failPreviewDeploy,
    teardownPreviewEnvironment,
    markPreviewDeploySuperseded,
}) satisfies PreviewkitActivities;
