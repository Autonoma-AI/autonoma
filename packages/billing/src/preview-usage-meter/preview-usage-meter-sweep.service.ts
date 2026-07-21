import type { PrismaClient } from "@autonoma/db";
import { PreviewkitStatus } from "@autonoma/db";
import { Service } from "../service";
import type { BillingService } from "../types";
import type { AmpPrometheusClient } from "./amp-prometheus-client";

const WINDOW_MS = 15 * 60 * 1000;
const WINDOW_SECONDS = WINDOW_MS / 1000;
// Windows close this far behind wall clock to give AMP ingestion time to land
// the trailing samples of the window before it's queried.
const INGESTION_LAG_MS = 5 * 60 * 1000;
// Bounds one sweep run's AMP query cost/duration: a stale checkpoint catches up
// in 4-hour chunks across multiple sweep runs rather than one giant backfill.
const CATCH_UP_CAP_WINDOWS = 16;
// Recently-torn-down environments still need their trailing windows closed from
// AMP's retained historical samples - comfortably wider than the 15-min sweep
// cadence so a missed sweep cycle or two doesn't drop a torn-down environment.
const RECENT_TEARDOWN_LOOKBACK_MS = 2 * 60 * 60 * 1000;
// A window with zero samples in both series pages once its predecessor was
// also zero-sample - one missed scrape is noise, two in a row is a dead scraper.

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

function earliestCeiledCheckpoint(environments: Array<Pick<MeteredEnvironment, "checkpoint">>): Date | undefined {
    return environments
        .map((env) => ceilToWindowBoundary(env.checkpoint))
        .reduce<Date | undefined>(
            (earliest, next) => (earliest == null || next < earliest ? next : earliest),
            undefined,
        );
}

/**
 * Closes wall-clock-aligned 15-minute previewkit compute-usage windows from AMP
 * (Amazon Managed Prometheus) and deducts the corresponding credits. Run every
 * 15 minutes; safe to re-run (or crash mid-run) since every write is keyed on
 * (environmentId, windowStart) or the window id, so a retry is a no-op.
 */
export class PreviewUsageMeterSweepService extends Service {
    constructor(
        private readonly db: PrismaClient,
        private readonly amp: AmpPrometheusClient,
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
                    this.amp.queryVcpuSecondsByNamespace(windowEnd),
                    this.amp.queryAverageGbByNamespace(windowEnd),
                ]);
            } catch (error) {
                this.logger.error("AMP query failed; stopping sweep without advancing past this window", error, {
                    windowStart: currentWindowStart,
                    windowEnd,
                });
                break;
            }

            const results = await Promise.all(
                due.map(async (env) => {
                    const vcpuSeconds = cpuByNamespace.get(env.namespace) ?? 0;
                    const gbSeconds = (averageGbByNamespace.get(env.namespace) ?? 0) * WINDOW_SECONDS;
                    const degraded = !cpuByNamespace.has(env.namespace) && !averageGbByNamespace.has(env.namespace);

                    const succeeded = await this.closeWindow(
                        env,
                        currentWindowStart,
                        windowEnd,
                        vcpuSeconds,
                        gbSeconds,
                        degraded,
                    );
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

    /** Ready environments (open-ended) plus recently-torn-down ones still owed a trailing window from AMP's retained history. */
    private async selectEnvironments(now: Date): Promise<MeteredEnvironment[]> {
        const globalWindowEnd = floorToWindowBoundary(new Date(now.getTime() - INGESTION_LAG_MS));

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
            const checkpoint = env.meteredAt ?? env.deployedAt;
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
            const checkpoint = env.meteredAt ?? env.deployedAt;
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
     * Writes the window row and (if it wasn't already recorded) deducts credits for
     * it. Returns whether the environment's checkpoint may advance past this window -
     * `false` only when the deduction itself threw, so a transient billing failure
     * doesn't silently forfeit the charge: the window row exists either way (it's
     * useful usage data on its own), but the checkpoint stays behind until a retry
     * succeeds.
     */
    private async closeWindow(
        env: MeteredEnvironment,
        windowStart: Date,
        windowEnd: Date,
        vcpuSeconds: number,
        gbSeconds: number,
        degraded: boolean,
    ): Promise<boolean> {
        const window = await this.db.previewkitUsageWindow.upsert({
            where: { environmentId_windowStart: { environmentId: env.id, windowStart } },
            create: {
                environmentId: env.id,
                organizationId: env.organizationId,
                windowStart,
                windowEnd,
                vcpuSeconds,
                gbSeconds,
                degraded,
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
            degraded,
        });

        if (degraded) {
            await this.alertIfConsecutivelyDegraded(env, windowStart);
        }

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

        await this.db.previewkitEnvironment.updateMany({
            where: { id: env.id, OR: [{ meteredAt: null }, { meteredAt: { lt: windowEnd } }] },
            data: { meteredAt: windowEnd },
        });

        return true;
    }

    private async alertIfConsecutivelyDegraded(env: MeteredEnvironment, windowStart: Date): Promise<void> {
        const previousWindow = await this.db.previewkitUsageWindow.findFirst({
            where: { environmentId: env.id, windowStart: { lt: windowStart } },
            orderBy: { windowStart: "desc" },
            select: { degraded: true },
        });

        if (previousWindow?.degraded !== true) return;

        this.logger.fatal(
            "Previewkit environment degraded for 2+ consecutive usage windows - scraper likely not collecting",
            {
                environmentId: env.id,
                namespace: env.namespace,
                windowStart,
            },
        );
    }
}
