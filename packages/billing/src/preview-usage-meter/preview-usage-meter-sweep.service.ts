import type { PrismaClient } from "@autonoma/db";
import { PreviewkitStatus } from "@autonoma/db";
import { Service } from "../service";
import type { BillingService } from "../types";
import type { PrometheusClient } from "./prometheus-client";

const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
// Windows close this far behind wall clock to give remote_write ingestion time
// to land the trailing samples of the window before it's queried.
const INGESTION_LAG_MS = 5 * 60 * 1000;
// Bounds one sweep run's query cost/duration: a stale checkpoint catches up
// in 4-hour chunks across multiple sweep runs rather than one giant backfill.
const CATCH_UP_CAP_WINDOWS = 16;
// Recently-torn-down environments still need their trailing windows closed from
// Prometheus's retained history - comfortably wider than the 15-min sweep
// cadence so a missed sweep cycle or two doesn't drop a torn-down environment.
const RECENT_TEARDOWN_LOOKBACK_MS = 2 * 60 * 60 * 1000;
// Prometheus keeps 7d/25GB (deployment/prometheus-agent/README.md) and evicts on
// whichever bound hits first, so samples much older than a day aren't reliably
// there. A checkpoint behind this horizon can only ever close windows at zero
// usage, so metering resumes from the horizon instead of grinding through them.
// Samples that stop arriving leave no trace at all - the windows read as idle,
// and nothing alerts on it. previewkit-metering only covers this job failing to
// run, which is a different thing.
const MAX_BACKFILL_MS = 24 * 60 * 60 * 1000;

// Caps the ready-environments query so a runaway fleet can't OOM the cronjob.
// Least-recently-metered environments sort first, so a fleet past this size
// still rotates through its backlog across runs rather than starving the tail.
const READY_ENVIRONMENTS_QUERY_LIMIT = 5000;

interface MeteredEnvironment {
    id: string;
    organizationId: string;
    namespace: string;
    checkpoint: Date;
    /** Exclusive upper bound on windowEnd - now (aligned) for a running environment, tornDownAt (aligned) for a torn-down one. */
    boundary: Date;
}

interface WindowClosure {
    env: MeteredEnvironment;
    windowStart: Date;
    windowEnd: Date;
    vcpuSeconds: number;
    gbSeconds: number;
}

export interface PreviewUsageMeterSweepResult {
    windowsClosed: number;
    environmentsMetered: number;
}

/** The one BillingService capability the sweep needs - not the whole surface (Stripe, promo codes, generation gates, ...). */
type PreviewUsageBillingService = Pick<BillingService, "deductCreditsForPreviewUsage">;

function floorToWindowBoundary(date: Date): Date {
    return new Date(Math.floor(date.getTime() / WINDOW_MS) * WINDOW_MS);
}

function ceilToWindowBoundary(date: Date): Date {
    return new Date(Math.ceil(date.getTime() / WINDOW_MS) * WINDOW_MS);
}

/** Newest window boundary far enough behind wall clock for its samples to have landed. */
function liveEdge(now: Date): Date {
    return floorToWindowBoundary(new Date(now.getTime() - INGESTION_LAG_MS));
}

function earliestCeiledCheckpoint(environments: Array<Pick<MeteredEnvironment, "checkpoint">>): Date | undefined {
    return environments
        .map((env) => ceilToWindowBoundary(env.checkpoint))
        .reduce<Date | undefined>(
            (earliest, next) => (earliest == null || next < earliest ? next : earliest),
            undefined,
        );
}

/**
 * Closes wall-clock-aligned 15-minute previewkit compute-usage windows from the
 * self-hosted Prometheus and deducts the corresponding credits. Run every
 * 15 minutes; safe to re-run (or crash mid-run) since every write is keyed on
 * (environmentId, windowStart) or the window id, so a retry is a no-op.
 */
export class PreviewUsageMeterSweepService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly prometheus: PrometheusClient,
        private readonly billingService: PreviewUsageBillingService,
    ) {
        super();
    }

    async run(now: Date): Promise<PreviewUsageMeterSweepResult> {
        this.logger.info("Starting previewkit usage-meter sweep", { now });

        const environments = await this.selectEnvironments(now);
        if (environments.length === 0) {
            this.logger.info("No environments due for previewkit usage metering");
            return { windowsClosed: 0, environmentsMetered: 0 };
        }

        let windowStart = earliestCeiledCheckpoint(environments);
        let windowsClosed = 0;
        let environmentsMetered = 0;

        while (windowStart != null && windowsClosed < CATCH_UP_CAP_WINDOWS) {
            const currentWindowStart = windowStart;
            const windowEnd = new Date(currentWindowStart.getTime() + WINDOW_MS);
            const due = environments.filter((env) => env.checkpoint <= currentWindowStart && windowEnd <= env.boundary);

            if (due.length === 0) {
                windowStart = earliestCeiledCheckpoint(
                    environments.filter((env) => env.checkpoint > currentWindowStart),
                );
                continue;
            }

            let cpuByNamespace: Map<string, number>;
            let averageGbByNamespace: Map<string, number>;
            try {
                [cpuByNamespace, averageGbByNamespace] = await Promise.all([
                    this.prometheus.queryVcpuSecondsByNamespace(windowEnd),
                    this.prometheus.queryAverageGbByNamespace(windowEnd),
                ]);
            } catch (error) {
                this.logger.error("Prometheus query failed; stopping sweep without advancing past this window", error, {
                    windowStart: currentWindowStart,
                    windowEnd,
                });
                break;
            }

            const results = await Promise.all(
                due.map(async (env) => {
                    const succeeded = await this.closeWindow({
                        env,
                        windowStart: currentWindowStart,
                        windowEnd,
                        vcpuSeconds: cpuByNamespace.get(env.namespace) ?? 0,
                        gbSeconds: (averageGbByNamespace.get(env.namespace) ?? 0) * WINDOW_SECONDS,
                    });
                    return { env, succeeded };
                }),
            );

            for (const result of results) {
                if (result.succeeded) {
                    result.env.checkpoint = windowEnd;
                    environmentsMetered++;
                    continue;
                }

                // Deduction failed for this window - leave its checkpoint where it was and
                // drop it from this run entirely so later windows in this same run don't
                // treat it as caught up. The next sweep invocation will pick this window
                // back up from the real (unadvanced) meteredAt and retry the deduction,
                // which is idempotent on the window id.
                const index = environments.indexOf(result.env);
                if (index !== -1) environments.splice(index, 1);
            }

            windowStart = windowEnd;
            windowsClosed++;
        }

        this.logger.info("Previewkit usage-meter sweep complete", { windowsClosed, environmentsMetered });
        return { windowsClosed, environmentsMetered };
    }

    /** Ready environments (open-ended) plus recently-torn-down ones still owed a trailing window from Prometheus's retained history. */
    private async selectEnvironments(now: Date): Promise<MeteredEnvironment[]> {
        const globalWindowEnd = liveEdge(now);
        const backfillHorizon = ceilToWindowBoundary(new Date(now.getTime() - MAX_BACKFILL_MS));

        const [readyEnvs, recentlyTornDown] = await Promise.all([
            this.db.previewkitEnvironment.findMany({
                where: { status: PreviewkitStatus.ready },
                select: { id: true, organizationId: true, namespace: true, meteredAt: true, deployedAt: true },
                orderBy: { meteredAt: "asc" },
                take: READY_ENVIRONMENTS_QUERY_LIMIT,
            }),
            this.db.previewkitEnvironment.findMany({
                where: {
                    status: PreviewkitStatus.torn_down,
                    tornDownAt: { gte: new Date(now.getTime() - RECENT_TEARDOWN_LOOKBACK_MS) },
                },
                select: {
                    id: true,
                    organizationId: true,
                    namespace: true,
                    meteredAt: true,
                    deployedAt: true,
                    tornDownAt: true,
                },
            }),
        ]);

        const environments: MeteredEnvironment[] = [];

        for (const env of readyEnvs) {
            const checkpoint = this.clampToHorizon(env.meteredAt ?? env.deployedAt, backfillHorizon, env.id);
            if (checkpoint == null) continue;
            if (checkpoint >= globalWindowEnd) continue;
            environments.push({
                id: env.id,
                organizationId: env.organizationId,
                namespace: env.namespace,
                checkpoint,
                boundary: globalWindowEnd,
            });
        }

        for (const env of recentlyTornDown) {
            if (env.tornDownAt == null) continue;
            const checkpoint = this.clampToHorizon(env.meteredAt ?? env.deployedAt, backfillHorizon, env.id);
            if (checkpoint == null) continue;

            const boundary = new Date(
                Math.min(globalWindowEnd.getTime(), floorToWindowBoundary(env.tornDownAt).getTime()),
            );
            if (checkpoint >= boundary) continue;

            environments.push({
                id: env.id,
                organizationId: env.organizationId,
                namespace: env.namespace,
                checkpoint,
                boundary,
            });
        }

        return environments;
    }

    /**
     * Moves a checkpoint that predates the retention horizon up to it, so an
     * environment that went unmetered for days (a stuck cronjob, a fresh
     * Prometheus) resumes from queryable samples instead of closing hundreds of
     * empty windows nobody can price.
     */
    private clampToHorizon(checkpoint: Date | null, horizon: Date, environmentId: string): Date | undefined {
        if (checkpoint == null) return undefined;
        if (checkpoint >= horizon) return checkpoint;

        this.logger.warn("Usage-meter checkpoint predates the retention horizon; skipping ahead", {
            environmentId,
            checkpoint,
            horizon,
        });
        return horizon;
    }

    /**
     * Writes the window row and (if it wasn't already recorded) deducts credits for
     * it. Returns whether the environment's checkpoint may advance past this window -
     * `false` only when the deduction itself threw, so a transient billing failure
     * doesn't silently forfeit the charge: the window row exists either way (it's
     * useful usage data on its own), but the checkpoint stays behind until a retry
     * succeeds. A window with no measured usage at all (no samples came back for
     * either series) isn't written - it prices to nothing either way, and keeping it
     * out of the table avoids a row that's indistinguishable from a genuinely idle
     * environment.
     */
    private async closeWindow({
        env,
        windowStart,
        windowEnd,
        vcpuSeconds,
        gbSeconds,
    }: WindowClosure): Promise<boolean> {
        if (vcpuSeconds === 0 && gbSeconds === 0) {
            this.logger.info("Skipping previewkit usage window with no measured usage", {
                environmentId: env.id,
                windowStart,
                windowEnd,
            });
        } else {
            const window = await this.db.previewkitUsageWindow.upsert({
                where: { environmentId_windowStart: { environmentId: env.id, windowStart } },
                create: {
                    environmentId: env.id,
                    organizationId: env.organizationId,
                    windowStart,
                    windowEnd,
                    vcpuSeconds,
                    gbSeconds,
                },
                update: {},
            });

            this.logger.info("Closed previewkit usage window", {
                environmentId: env.id,
                usageWindowId: window.id,
                windowStart,
                windowEnd,
                vcpuSeconds,
                gbSeconds,
            });

            try {
                await this.billingService.deductCreditsForPreviewUsage(
                    env.organizationId,
                    window.id,
                    vcpuSeconds,
                    gbSeconds,
                );
            } catch (error) {
                this.logger.error("Failed to deduct previewkit usage credits for window; retrying next sweep", error, {
                    environmentId: env.id,
                    usageWindowId: window.id,
                });
                return false;
            }
        }

        await this.db.previewkitEnvironment.updateMany({
            where: { id: env.id, OR: [{ meteredAt: null }, { meteredAt: { lt: windowEnd } }] },
            data: { meteredAt: windowEnd },
        });

        return true;
    }
}
