import { db } from "@autonoma/db";
import type {
    BuildPreviewImagesInput,
    BuildPreviewImagesOutput,
    DeployPreviewEnvironmentInput,
    DeployPreviewEnvironmentOutput,
    FailPreviewDeployInput,
    FinalizePreviewDeployInput,
    PreparePreviewDeployInput,
    PreparePreviewDeployOutput,
    PreviewDeployEvent,
    PreviewkitActivities,
    TeardownPreviewEnvironmentInput,
} from "@autonoma/workflow/activities";
import { Context } from "@temporalio/activity";
import { createPreviewkitServices, type PreviewkitServices } from "../create-services";
import { type Logger, logger as rootLogger } from "../logger";

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
 * Heartbeat every 30s so a stuck or killed worker is detected within the
 * activity's `heartbeatTimeout` (2m) and Temporal reschedules the activity.
 */
function startHeartbeat(): NodeJS.Timeout {
    return setInterval(() => Context.current().heartbeat(), 30_000);
}

export async function preparePreviewDeploy(input: PreparePreviewDeployInput): Promise<PreparePreviewDeployOutput> {
    const logger = rootLogger.child({ name: "preparePreviewDeploy" });
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
    logger.info("Building preview images", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const heartbeat = startHeartbeat();
    try {
        const { previewPipeline } = await getServices();
        return await previewPipeline.build(input.event, input.namespace, input.configRevisionId);
    } finally {
        clearInterval(heartbeat);
    }
}

export async function deployPreviewEnvironment(
    input: DeployPreviewEnvironmentInput,
): Promise<DeployPreviewEnvironmentOutput> {
    const logger = rootLogger.child({ name: "deployPreviewEnvironment" });
    logger.info("Deploying preview environment", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const heartbeat = startHeartbeat();
    try {
        const { previewPipeline } = await getServices();
        return await previewPipeline.deployEnvironment(input);
    } finally {
        clearInterval(heartbeat);
    }
}

export async function finalizePreviewDeploy(input: FinalizePreviewDeployInput): Promise<void> {
    const logger = rootLogger.child({ name: "finalizePreviewDeploy" });
    logger.info("Finalizing preview deploy", { repo: input.event.repoFullName, pr: input.event.prNumber });

    const { previewPipeline } = await getServices();
    await previewPipeline.finalize(input.event, input.namespace, input.commentId, input.feedbackEnabled, input.result);
}

export async function failPreviewDeploy(input: FailPreviewDeployInput): Promise<void> {
    const logger = rootLogger.child({ name: "failPreviewDeploy" });
    logger.info("Running preview deploy failure finalizer", {
        repo: input.event.repoFullName,
        pr: input.event.prNumber,
    });

    const { previewPipeline } = await getServices();
    await previewPipeline.fail(input.event, input.namespace, input.commentId, input.feedbackEnabled, input.error);
}

export async function teardownPreviewEnvironment(input: TeardownPreviewEnvironmentInput): Promise<void> {
    const logger = rootLogger.child({ name: "teardownPreviewEnvironment" });
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

// Compile-time check: ensure exported activities match the PreviewkitActivities contract.
({
    preparePreviewDeploy,
    buildPreviewImages,
    deployPreviewEnvironment,
    finalizePreviewDeploy,
    failPreviewDeploy,
    teardownPreviewEnvironment,
}) satisfies PreviewkitActivities;
