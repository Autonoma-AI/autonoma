import { db, Prisma } from "@autonoma/db";
import { encryptPreviewkitBypassToken } from "@autonoma/utils";
import type { BuildRuntime } from "../builder/builder";
import type { AddonConfig, AppConfig, PreviewConfig, ServiceConfig } from "../config/schema";
import { env } from "../env";
import { logger as rootLogger } from "../logger";

export type PreviewkitStatus = "pending" | "building" | "deploying" | "ready" | "failed" | "superseded" | "torn_down";

// Full per-app lifecycle status (mirrors the Prisma `PreviewkitAppStatus`
// enum). pending -> building -> built -> deploying -> ready is the happy path;
// build_failed / deploy_failed are terminal, skipped means the build failed
// upstream so the deploy was never attempted.
export type PreviewkitAppStatus =
    | "pending"
    | "building"
    | "built"
    | "deploying"
    | "ready"
    | "build_failed"
    | "deploy_failed"
    | "skipped";

// One per-app state transition written to PreviewkitAppInstance. The mutable
// fields are overwritten wholesale on every write (an absent field clears the
// column), so a caller transitioning an app must pass the complete intended
// state - e.g. carry `imageTag` through the `deploying` and `ready` writes so
// it is not wiped. `port` always comes from the resolved config.
export interface AppStateUpdate {
    appName: string;
    status: PreviewkitAppStatus;
    port: number;
    imageTag?: string;
    url?: string;
    error?: string;
}

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

export interface PreviewkitManifest {
    apps: Array<Pick<AppConfig, "name" | "port" | "primary">>;
    services: Array<Pick<ServiceConfig, "name" | "recipe" | "version">>;
    addons: Array<Pick<AddonConfig, "name" | "provider">>;
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
 * - `success`: the image was built and pushed; `imageTag` is set.
 * - `failed`: the build threw; `error` carries the message.
 *
 * Build output itself lives in the build-log sink (Grafana Loki), keyed by
 * namespace - it is not part of the outcome.
 */
export type AppBuildOutcome =
    | { status: "success"; imageTag: string; durationMs: number; runtime?: BuildRuntime }
    | { status: "failed"; durationMs: number; error: string; runtime?: BuildRuntime };

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
    bypassToken?: string;
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
            // Clear the previous attempt's config snapshot; recordResolvedConfig rewrites it
            // once this attempt resolves its config. Without this, a deploy that fails before
            // that write leaves the row describing the new head/status but the prior config.
            resolvedConfig: Prisma.DbNull,
            configRevisionId: null,
        },
    });
}

export interface ResolvedConfigSnapshotInput {
    namespace: string;
    resolvedConfig: PreviewConfig;
    configRevisionId?: string;
}

/**
 * Snapshots the fully-resolved config used for a deploy onto the environment
 * row. Immutable per deploy: a re-deploy of the same PR reproduces the same
 * topology even if the Application's active revision changes afterwards.
 * `configRevisionId` records which primary revision fed the snapshot (absent
 * when the config came straight from a `.preview.yaml` and the best-effort
 * import didn't yield a revision id).
 */
export async function recordResolvedConfig(input: ResolvedConfigSnapshotInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordResolvedConfig" });
    const { namespace, resolvedConfig, configRevisionId } = input;
    logger.info("Recording resolved config snapshot", {
        namespace,
        configRevisionId,
        appCount: resolvedConfig.apps.length,
    });

    const existing = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (existing == null) {
        logger.warn("Skipping resolved config snapshot: no environment row found", { namespace });
        return;
    }

    await db.previewkitEnvironment.update({
        where: { namespace },
        data: {
            resolvedConfig,
            configRevisionId: configRevisionId ?? null,
        },
    });
}

export async function recordEnvironmentManifest(namespace: string, config: PreviewConfig): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentManifest" });
    const manifest: PreviewkitManifest = {
        apps: config.apps.map((app) => ({
            name: app.name,
            port: app.port,
            primary: app.primary,
        })),
        services: config.services.map((service) => ({
            name: service.name,
            recipe: service.recipe,
            version: service.version,
        })),
        addons: config.addons.map((addon) => ({
            name: addon.name,
            provider: addon.provider,
        })),
    };

    logger.info("Recording environment manifest", {
        namespace,
        apps: manifest.apps.length,
        services: manifest.services.length,
        addons: manifest.addons.length,
    });

    await db.previewkitEnvironment.update({
        where: { namespace },
        data: { manifest },
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

    // Upsert keyed on (environment, sha) so a Temporal activity retry updates
    // the existing build row instead of inserting a duplicate. The nested
    // `deleteMany` clears the prior per-app rows before re-creating them, since
    // they're uniquely keyed by (buildId, appName) and a bare re-create would
    // conflict on retry.
    const appBuildRows = Object.entries(appBuilds).map(([appName, outcome]) => toAppBuildRow(appName, outcome));
    await db.previewkitBuild.upsert({
        where: { environmentId_headSha: { environmentId: env.id, headSha } },
        create: {
            environmentId: env.id,
            headSha,
            status,
            durationMs,
            finishedAt: new Date(),
            error: error ?? null,
            appBuilds: { create: appBuildRows },
        },
        update: {
            status,
            durationMs,
            finishedAt: new Date(),
            error: error ?? null,
            appBuilds: { deleteMany: {}, create: appBuildRows },
        },
    });
}

/**
 * Marks the in-flight build for a (namespace, sha) as `superseded` because a
 * newer commit cancelled the deploy. Writes ONLY the immutable build row - it
 * must never touch the environment row, which is owned by the newest run that
 * is already overwriting it. Idempotent (upsert keyed on (environment, sha));
 * a no-op if the environment row is gone.
 */
export async function markBuildSuperseded(namespace: string, headSha: string): Promise<void> {
    const logger = rootLogger.child({ name: "markBuildSuperseded" });
    logger.info("Marking build superseded", { namespace, headSha });

    const env = await db.previewkitEnvironment.findUnique({
        where: { namespace },
        select: { id: true },
    });
    if (env == null) {
        logger.warn("Superseded mark skipped: no environment row found", { namespace, headSha });
        return;
    }

    await db.previewkitBuild.upsert({
        where: { environmentId_headSha: { environmentId: env.id, headSha } },
        create: {
            environmentId: env.id,
            headSha,
            status: "superseded",
            finishedAt: new Date(),
            error: "Superseded by a newer commit",
        },
        update: {
            status: "superseded",
            finishedAt: new Date(),
            error: "Superseded by a newer commit",
        },
    });
}

/**
 * Flattens a per-app build outcome into a `PreviewkitAppBuild` create row.
 * `imageTag` is only present on success and `error` only on failure, so each
 * is null for the other variant.
 */
function toAppBuildRow(appName: string, outcome: AppBuildOutcome) {
    return {
        appName,
        status: outcome.status,
        durationMs: outcome.durationMs,
        imageTag: outcome.status === "success" ? outcome.imageTag : null,
        error: outcome.status === "failed" ? outcome.error : null,
        // Legacy column from the retired S3 log archive; kept for historic
        // rows. Build logs are served from Loki now.
        logUrl: null,
        runtime: outcome.runtime ?? null,
    };
}

// Marks the environment row itself ready. Per-app rows are written separately
// via `recordAppStates` - this only owns the environment-level status, urls,
// deployedAt, and bypass token.
export async function recordEnvironmentReady(input: EnvironmentReadyInput): Promise<void> {
    const logger = rootLogger.child({ name: "recordEnvironmentReady" });
    const { namespace, urls, bypassToken } = input;
    logger.info("Recording environment ready", { namespace });

    const updated = await db.previewkitEnvironment.updateMany({
        where: { namespace },
        data: {
            status: "ready",
            phase: "ready",
            error: null,
            urls,
            deployedAt: new Date(),
            bypassToken:
                bypassToken != null ? encryptPreviewkitBypassToken(bypassToken, env.BYPASS_TOKEN_KEY) : undefined,
        },
    });
    if (updated.count === 0) {
        logger.warn("Environment ready but no environment row found", { namespace });
    }
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

// Moment 0: seed one `pending` PreviewkitAppInstance row per configured app, so
// every app has a distinct status record before any build/deploy work runs.
// Idempotent and safe to re-run on redeploy - it resets each app to `pending`
// (clearing the prior commit's imageTag/url/error) and prunes rows for apps
// that the new config no longer declares.
export async function recordAppsPending(
    namespace: string,
    apps: Array<{ appName: string; port: number }>,
): Promise<void> {
    const logger = rootLogger.child({ name: "recordAppsPending" });
    logger.info("Recording apps pending", { namespace, appCount: apps.length });

    const envRow = await db.previewkitEnvironment.findUnique({ where: { namespace }, select: { id: true } });
    if (envRow == null) {
        logger.warn("Cannot seed pending apps: no environment row found", { namespace });
        return;
    }

    const appNames = apps.map((a) => a.appName);
    await db.$transaction(async (tx) => {
        await tx.previewkitAppInstance.deleteMany({
            where: { environmentId: envRow.id, appName: { notIn: appNames } },
        });
        for (const app of apps) {
            await tx.previewkitAppInstance.upsert({
                where: { environmentId_appName: { environmentId: envRow.id, appName: app.appName } },
                create: { environmentId: envRow.id, appName: app.appName, status: "pending", port: app.port },
                update: {
                    status: "pending",
                    port: app.port,
                    imageTag: null,
                    url: null,
                    error: null,
                },
            });
        }
    });
}

// Bulk-transitions per-app lifecycle rows. Each update overwrites the mutable
// fields wholesale (see AppStateUpdate), upserting so a transition self-heals
// even if the moment-0 `recordAppsPending` seed was lost. Used for the
// building / built / build_failed / deploying / ready / deploy_failed / skipped
// transitions across the build and deploy phases.
export async function recordAppStates(namespace: string, updates: AppStateUpdate[]): Promise<void> {
    const logger = rootLogger.child({ name: "recordAppStates" });
    if (updates.length === 0) return;
    logger.info("Recording app states", { namespace, count: updates.length });

    const envRow = await db.previewkitEnvironment.findUnique({ where: { namespace }, select: { id: true } });
    if (envRow == null) {
        logger.warn("Cannot record app states: no environment row found", { namespace });
        return;
    }

    await db.$transaction(async (tx) => {
        for (const u of updates) {
            const mutable = {
                status: u.status,
                port: u.port,
                imageTag: u.imageTag ?? null,
                url: u.url ?? null,
                error: u.error ?? null,
            };
            await tx.previewkitAppInstance.upsert({
                where: { environmentId_appName: { environmentId: envRow.id, appName: u.appName } },
                create: { environmentId: envRow.id, appName: u.appName, ...mutable },
                update: mutable,
            });
        }
    });
}
