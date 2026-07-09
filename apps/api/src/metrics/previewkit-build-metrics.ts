import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { Gauge, type Registry } from "prom-client";

// A `building` app row older than this is treated as leaked (a runner that
// died without writing a terminal state) and excluded from the gauge, so a
// crash can only inflate the metric for a bounded window. Invariant: must stay
// ABOVE the deploy Job's activeDeadlineSeconds (90 min - PreviewkitJobLauncher),
// which bounds how long a row can legitimately sit `building` (buildkit queue
// wait counts as `building`, and transient retries never refresh updatedAt) -
// a real build must never be dropped from the demand signal KEDA scales the
// pool on while its Job is still alive.
const BUILDING_FRESHNESS_MS = 100 * 60 * 1000;

/**
 * Exports this environment's previewkit build load for Prometheus. The value
 * is recomputed from the DB on every scrape: previewkit runners transition
 * each app row to `building` when its build is admitted to the warm pool's
 * queue and to a terminal state when it ends, so the count of fresh
 * `building` rows is this env's DEMAND on the shared warm buildkit pool -
 * builds queued for a slot plus builds running (buildkitd itself only exposes
 * Go runtime metrics - there is no daemon-side in-flight gauge to scrape).
 * Queued builds counting toward the series is what lets KEDA scale the pool
 * out to drain the queue.
 *
 * Every env's API (prod / beta / alpha) exports its own DB view; the
 * `previewkit:app_builds_in_flight:sum` recording rule
 * (deployment/prometheus/alert-rules.yaml) dedupes API replicas per namespace
 * and sums envs into the pool-wide series that dashboards and the KEDA
 * ScaledObject autoscaling the pool read
 * (deployment/buildkit/buildkit-scaledobject.yaml).
 *
 * Scrape failures are logged and otherwise swallowed: the gauge then keeps its
 * last value for that scrape, because a DB hiccup must not fail the whole
 * /metrics response (which also carries the process metrics).
 */
export class PreviewkitBuildMetrics {
    private readonly logger: Logger;

    constructor(
        private readonly db: PrismaClient,
        registry: Registry,
    ) {
        this.logger = logger.child({ name: this.constructor.name });

        const buildsInFlight: Gauge = new Gauge({
            name: "previewkit_app_builds_in_flight",
            help: "App image builds this environment currently runs on the warm buildkit pool (fresh `building` app rows)",
            registers: [registry],
            collect: async () => {
                const count = await this.countBuildingApps();
                if (count != null) buildsInFlight.set(count);
            },
        });
    }

    /**
     * Counts app instances whose image build is currently running: status
     * `building`, transitioned recently (leak guard), and belonging to an
     * environment that still exists as far as previewkit is concerned - a PR
     * closed mid-build tears the environment down without ever writing the
     * app's terminal state, so `torn_down`/`failed` environments are excluded
     * outright rather than waiting out the freshness window.
     */
    private async countBuildingApps(): Promise<number | undefined> {
        // `gte` so a build sitting exactly at the window edge (the documented
        // worst legitimate case) is still counted; only strictly older rows drop.
        const freshAfter = new Date(Date.now() - BUILDING_FRESHNESS_MS);
        try {
            return await this.db.previewkitAppInstance.count({
                where: {
                    status: "building",
                    updatedAt: { gte: freshAfter },
                    environment: { status: { notIn: ["torn_down", "failed"] } },
                },
            });
        } catch (err) {
            this.logger.error("Failed to count in-flight previewkit builds for metrics scrape", { err });
            return undefined;
        }
    }
}
