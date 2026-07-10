import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";

/** Env statuses at which a deploy has settled (nothing more will happen without a new trigger). */
const TERMINAL_ENV_STATUSES = new Set(["ready", "failed", "torn_down"]);
/** App-instance statuses at which one service's (re)deploy has settled. */
const TERMINAL_APP_STATUSES = new Set(["ready", "build_failed", "deploy_failed", "skipped"]);
/** Default server-side wait budget; kept under a typical 60s proxy read timeout so the call returns cleanly. */
const DEFAULT_WAIT_MS = 45_000;
/** Hard ceiling on one wait call's budget - the agent re-calls to keep waiting past this. */
const MAX_WAIT_MS = 55_000;
/** Poll interval while waiting for a terminal state. */
const WAIT_POLL_MS = 4_000;

export interface PreviewkitEnvironmentStatus {
    repoFullName: string;
    prNumber: number;
    status: string;
    phase: string | undefined;
    createdAt: Date;
    updatedAt: Date;
    lastDeployedSha: string;
    urls: Record<string, string>;
    error: string | undefined;
}

/** The `previewkit_environment` columns the status response is built from. */
interface EnvironmentRow {
    status: string;
    phase: string | null;
    error: string | null;
    urls: unknown;
    headSha: string;
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Reads preview-environment status straight from the database. Previewkit's own
 * status route read live Kubernetes namespace annotations; the pipeline already
 * mirrors that state into `previewkit_environment` (the admin dashboard reads it
 * the same way), so the API serves status natively from the DB - no Kubernetes
 * client and no forwarding needed.
 */
export class PreviewkitEnvironmentsService {
    private readonly logger: Logger;

    constructor(private readonly db: PrismaClient) {
        this.logger = logger.child({ name: this.constructor.name });
    }

    /**
     * Status for one (repo, PR) preview environment, or undefined if none exists.
     * Org-scopes user callers so one org cannot read another org's status / URLs /
     * errors: a foreign environment is indistinguishable from "not found". Service
     * callers (callerOrgId == null) are trusted and not narrowed.
     */
    async getStatus(
        repoFullName: string,
        prNumber: number,
        callerOrgId: string | undefined,
    ): Promise<PreviewkitEnvironmentStatus | undefined> {
        this.logger.info("Reading previewkit environment status", { repoFullName, prNumber });

        const row = await this.db.previewkitEnvironment.findFirst({
            where:
                callerOrgId != null
                    ? { repoFullName, prNumber, organizationId: callerOrgId }
                    : { repoFullName, prNumber },
            select: {
                status: true,
                phase: true,
                error: true,
                urls: true,
                headSha: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (row == null) return undefined;
        return toEnvironmentStatus(repoFullName, prNumber, row);
    }

    /**
     * Resolve the Loki label key (`namespace`) + current `status` for one
     * environment's live log stream, applying the same org-scoping as
     * `getStatus`. Returns undefined when no such environment exists (or it
     * belongs to another org), which the SSE route maps to a 404.
     */
    async resolveStreamTarget(
        repoFullName: string,
        prNumber: number,
        callerOrgId: string | undefined,
    ): Promise<PreviewkitStreamTarget | undefined> {
        const row = await this.db.previewkitEnvironment.findFirst({
            where:
                callerOrgId != null
                    ? { repoFullName, prNumber, organizationId: callerOrgId }
                    : { repoFullName, prNumber },
            select: { namespace: true, status: true },
        });

        if (row == null) return undefined;
        return { namespace: row.namespace, status: row.status };
    }

    /**
     * Waits (server-side, up to a bounded budget) for a preview's deploy to settle,
     * so a client's agent can trigger a rebuild/restart and then block until it can
     * keep debugging. When `appName` is given (the case after set_secret /
     * edit_previewkit_config, which redeploy one service) it watches that app
     * instance; otherwise it watches the environment. "Settled" requires a terminal
     * status AND a change since the call began - so a still-`ready` app whose rebuild
     * job has not yet flipped it is not mistaken for done. Returns `settled: false`
     * with the current snapshot when the budget elapses; the agent calls again to
     * keep waiting. Returns undefined when no such environment exists (mapped to
     * "unavailable" by the tool).
     */
    async waitForDeploy(params: {
        repoFullName: string;
        prNumber: number;
        appName?: string;
        callerOrgId: string | undefined;
        timeoutMs?: number;
    }): Promise<WaitForDeployResult | undefined> {
        const { repoFullName, prNumber, appName, callerOrgId } = params;
        const budgetMs = Math.min(params.timeoutMs ?? DEFAULT_WAIT_MS, MAX_WAIT_MS);
        this.logger.info("Waiting for preview deploy", { repoFullName, prNumber, extra: { appName, budgetMs } });

        const baseline = await this.readDeployProgress(repoFullName, prNumber, appName, callerOrgId);
        if (baseline == null) return undefined;

        const deadline = Date.now() + budgetMs;
        let latest = baseline;
        while (!isSettled(latest, baseline)) {
            if (Date.now() >= deadline) {
                this.logger.info("Preview deploy still in progress at budget", {
                    repoFullName,
                    prNumber,
                    extra: { appName, status: latest.watchedStatus },
                });
                return toWaitResult(latest, false);
            }
            await sleep(WAIT_POLL_MS);
            const next = await this.readDeployProgress(repoFullName, prNumber, appName, callerOrgId);
            if (next == null) return undefined;
            latest = next;
        }

        this.logger.info("Preview deploy settled", {
            repoFullName,
            prNumber,
            extra: { appName, status: latest.watchedStatus },
        });
        return toWaitResult(latest, true);
    }

    /** Reads the env + (optional) watched app-instance snapshot used to decide settlement. */
    private async readDeployProgress(
        repoFullName: string,
        prNumber: number,
        appName: string | undefined,
        callerOrgId: string | undefined,
    ): Promise<DeployProgress | undefined> {
        const row = await this.db.previewkitEnvironment.findFirst({
            where:
                callerOrgId != null
                    ? { repoFullName, prNumber, organizationId: callerOrgId }
                    : { repoFullName, prNumber },
            select: {
                status: true,
                phase: true,
                error: true,
                urls: true,
                updatedAt: true,
                appInstances: {
                    select: { appName: true, status: true, error: true, url: true, updatedAt: true },
                    orderBy: { appName: "asc" },
                },
            },
        });
        if (row == null) return undefined;

        const watchedApp = appName != null ? row.appInstances.find((app) => app.appName === appName) : undefined;
        const watchedStatus = watchedApp?.status ?? row.status;
        const watchedUpdatedAt = (watchedApp?.updatedAt ?? row.updatedAt).getTime();
        const isApp = appName != null && watchedApp != null;
        return {
            envStatus: row.status,
            envError: row.error ?? undefined,
            urls: parseStringRecord(row.urls),
            apps: row.appInstances.map((app) => ({
                name: app.appName,
                status: app.status,
                error: app.error ?? undefined,
                url: app.url ?? undefined,
            })),
            watchedApp: appName,
            watchedStatus,
            watchedUpdatedAt,
            watchedIsApp: isApp,
        };
    }
}

/** Internal snapshot the wait loop compares across polls. */
interface DeployProgress {
    envStatus: string;
    envError?: string;
    urls: Record<string, string>;
    apps: Array<{ name: string; status: string; error?: string; url?: string }>;
    watchedApp?: string;
    watchedStatus: string;
    watchedUpdatedAt: number;
    watchedIsApp: boolean;
}

export interface WaitForDeployResult {
    /** True once the watched target reached a terminal status (and changed since the wait began). */
    settled: boolean;
    /** The overall environment status. */
    status: string;
    /** The watched app instance's status, when an app was named. */
    appStatus?: string;
    error?: string;
    urls: Record<string, string>;
    apps: Array<{ name: string; status: string; error?: string; url?: string }>;
    /** Present when not settled: tells the agent it can call wait_for_deploy again to keep waiting. */
    reason?: string;
}

/** Whether the watched target is in a terminal state that also post-dates the wait's baseline. */
function isSettled(latest: DeployProgress, baseline: DeployProgress): boolean {
    const terminal = latest.watchedIsApp
        ? TERMINAL_APP_STATUSES.has(latest.watchedStatus)
        : TERMINAL_ENV_STATUSES.has(latest.watchedStatus);
    return terminal && latest.watchedUpdatedAt > baseline.watchedUpdatedAt;
}

function toWaitResult(progress: DeployProgress, settled: boolean): WaitForDeployResult {
    return {
        settled,
        status: progress.envStatus,
        appStatus: progress.watchedIsApp ? progress.watchedStatus : undefined,
        error: progress.envError,
        urls: progress.urls,
        apps: progress.apps,
        reason: settled ? undefined : "Still in progress - call wait_for_deploy again to keep waiting.",
    };
}

/** Promise-based delay for the wait loop. */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Identifies which Loki stream to relay and whether the build has already finished. */
export interface PreviewkitStreamTarget {
    namespace: string;
    status: string;
}

/** Maps a `previewkit_environment` row to the public status shape. Pure; unit-tested. */
export function toEnvironmentStatus(
    repoFullName: string,
    prNumber: number,
    row: EnvironmentRow,
): PreviewkitEnvironmentStatus {
    return {
        repoFullName,
        prNumber,
        status: row.status,
        phase: row.phase ?? undefined,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        lastDeployedSha: row.headSha,
        urls: parseStringRecord(row.urls),
        error: row.error ?? undefined,
    };
}

/** Coerce a Prisma Json value into a flat Record<string,string>, dropping non-string values. */
function parseStringRecord(value: unknown): Record<string, string> {
    if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(value)) {
        if (typeof val === "string") out[key] = val;
    }
    return out;
}
