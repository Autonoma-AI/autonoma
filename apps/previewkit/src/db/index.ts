import { db } from "@autonoma/db";
import type { AppConfig } from "../config/schema";
import { logger as rootLogger } from "../logger";

export type PreviewkitStatus = "pending" | "building" | "deploying" | "ready" | "failed" | "torn_down";

export interface EnvironmentCreatedInput {
    repoFullName: string;
    prNumber: number;
    headSha: string;
    headRef: string;
    namespace: string;
    organizationId: string;
    githubRepositoryId?: number;
    commentId?: string;
}

export interface PhaseChangedInput {
    namespace: string;
    status: PreviewkitStatus;
    phase: string;
    error?: string;
}

/**
 * Per-app outcome of the build phase. Each app is recorded independently so
 * that one failed build doesn't erase the others from the history.
 *
 * - `ok`: the image was built and pushed; `imageTag` + `logUrl` are set.
 * - `failed`: the build threw. `error` carries the message; `logUrl` is set
 *   when the builder managed to upload the captured log (it usually does —
 *   the log upload only fails if S3 itself is unreachable or the log file
 *   is empty, both of which are rare).
 */
export type AppBuildOutcome =
    | { status: "ok"; imageTag: string; durationMs: number; logUrl: string }
    | { status: "failed"; durationMs: number; error: string; logUrl?: string };

export interface BuildFinishedInput {
    namespace: string;
    headSha: string;
    status: PreviewkitStatus;
    durationMs: number;
    appBuilds: Record<string, AppBuildOutcome>;
    error?: string;
}

export interface EnvironmentReadyInput {
    namespace: string;
    urls: Record<string, string>;
    apps: Array<{ appName: string; imageTag: string; port: number }>;
}

export async function recordEnvironmentCreated(input: EnvironmentCreatedInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentCreated" });
    const { repoFullName, prNumber, headSha, headRef, namespace, organizationId, githubRepositoryId, commentId } =
        input;
    logger.info("Recording environment created", { namespace, repoFullName, prNumber, organizationId });

    // On update, only overwrite `commentId` when the caller actually provides
    // one. Empty / undefined means "preserve the stored value" — important so
    // a deploy with feedback disabled (or a transient failure to post) doesn't
    // wipe out the existing PR comment id, which we rely on to keep the
    // single-comment-per-PR contract across pushes.
    const updateCommentId = commentId != null && commentId !== "";

    await db.previewkitEnvironment.upsert({
        where: { namespace },
        create: {
            namespace,
            repoFullName,
            prNumber,
            headSha,
            headRef,
            githubRepositoryId,
            commentId,
            status: "pending",
            phase: "initializing",
            organizationId,
        },
        update: {
            headSha,
            headRef,
            ...(updateCommentId ? { commentId } : {}),
            status: "pending",
            phase: "initializing",
            error: null,
            tornDownAt: null,
        },
    });
}

export async function recordPhaseChanged(input: PhaseChangedInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordPhaseChanged" });
    const { namespace, status, phase, error } = input;
    logger.info("Recording phase change", { namespace, status, phase });

    const existing = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (existing == null) {
        logger.warn("Skipping phase change: no environment row found", { namespace, status, phase });
        return;
    }

    await db.previewkitEnvironment.update({
        where: { namespace },
        data: {
            status,
            phase,
            error: error ?? null,
            deployedAt: status === "ready" ? new Date() : undefined,
        },
    });
}

export async function recordBuildFinished(input: BuildFinishedInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordBuildFinished" });
    const { namespace, headSha, status, durationMs, appBuilds, error } = input;
    logger.info("Recording build finished", { namespace, headSha, status, durationMs });

    const env = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (env == null) {
        logger.warn("Build finished but no environment row found", { namespace });
        return;
    }

    await db.previewkitBuild.create({
        data: {
            environmentId: env.id,
            headSha,
            status,
            durationMs,
            finishedAt: new Date(),
            appBuilds,
            error: error ?? null,
        },
    });
}

export async function recordEnvironmentReady(input: EnvironmentReadyInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentReady" });
    const { namespace, urls, apps } = input;
    logger.info("Recording environment ready", { namespace, appCount: apps.length });

    const env = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (env == null) {
        logger.warn("Environment ready but no environment row found", { namespace });
        return;
    }

    await db.$transaction(async (tx) => {
        await tx.previewkitEnvironment.update({
            where: { namespace },
            data: {
                status: "ready",
                phase: "ready",
                error: null,
                urls,
                deployedAt: new Date(),
            },
        });

        for (const app of apps) {
            await tx.previewkitAppInstance.upsert({
                where: { environmentId_appName: { environmentId: env.id, appName: app.appName } },
                create: {
                    environmentId: env.id,
                    appName: app.appName,
                    imageTag: app.imageTag,
                    url: urls[app.appName],
                    port: app.port,
                    ready: false,
                },
                update: {
                    imageTag: app.imageTag,
                    url: urls[app.appName],
                    port: app.port,
                    ready: false,
                },
            });
        }
    });
}

export async function recordEnvironmentTornDown(namespace: string): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentTornDown" });
    logger.info("Recording environment torn down", { namespace });

    await db.previewkitEnvironment.update({
        where: { namespace },
        data: {
            status: "torn_down",
            phase: "torn_down",
            tornDownAt: new Date(),
        },
    });
}

export function toAppInstances(apps: AppConfig[], imageTags: Record<string, string>): EnvironmentReadyInput["apps"] {
    // Only record instances for apps that actually built. Apps whose build
    // failed have no imageTag and never produced a Deployment, so emitting
    // a row for them would just lie about cluster state.
    return apps
        .filter((app) => {
            const tag = imageTags[app.name];
            return tag != null && tag !== "";
        })
        .map((app) => ({
            appName: app.name,
            imageTag: imageTags[app.name]!,
            port: app.port,
        }));
}

/**
 * Returns whether Previewkit should post comments / set commit statuses for this
 * organization. Defaults to `true` if the org row is missing — we'd rather emit
 * feedback than swallow it silently on a transient lookup failure.
 */
export async function isGithubFeedbackEnabledForOrg(organizationId: string): Promise<boolean> {
    const logger = rootLogger.child({ name: "isGithubFeedbackEnabledForOrg" });
    const org = await db.organization.findUnique({
        where: { id: organizationId },
        select: { previewkitGithubFeedbackEnabled: true },
    });
    if (org == null) {
        logger.warn("Organization not found, defaulting feedback to enabled", { organizationId });
        return true;
    }
    return org.previewkitGithubFeedbackEnabled;
}

/**
 * Lookup variant used at teardown, where the only stable identifier we have is
 * the K8s namespace. Defaults to `true` if no environment row exists.
 */
export async function isGithubFeedbackEnabledForNamespace(namespace: string): Promise<boolean> {
    const logger = rootLogger.child({ name: "isGithubFeedbackEnabledForNamespace" });
    const env = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { organization: { select: { previewkitGithubFeedbackEnabled: true } } },
    });
    if (env == null) {
        logger.warn("Environment row not found, defaulting feedback to enabled", { namespace });
        return true;
    }
    return env.organization.previewkitGithubFeedbackEnabled;
}
