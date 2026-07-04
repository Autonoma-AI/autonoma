import type { PrismaClient } from "@autonoma/db";
import { type Logger, logger } from "@autonoma/logger";
import { Gauge, type Registry } from "prom-client";

// A `building` app row older than this is treated as leaked (a runner that
// died without writing a terminal state) and excluded from the gauge, so a
// crash can only inflate the metric for a bounded window. Sized to the worst
// legitimate case - BUILD_TIMEOUT_MS (30 min) per attempt with up to 3
// transient-retry attempts - so a real build is never dropped mid-flight.
const BUILDING_FRESHNESS_MS = 90 * 60 * 1000;

/**
 * Exports this environment's previewkit build load for Prometheus. The value
 * is recomputed from the DB on every scrape: previewkit runners transition
 * each app row to `building` when its image build starts and to a terminal
 * state when it ends, so the count of fresh `building` rows is the number of
 * concurrent Solves this env currently has in flight on the shared warm
 * buildkit pool (buildkitd itself only exposes Go runtime metrics - there is
 * no daemon-side in-flight gauge to scrape).
 *
 * Every env's API (prod / beta / alpha) exports its own DB view; the
 * `previewkit:app_builds_in_flight:sum` recording rule
 * (deployment/prometheus/alert-rules.yaml) dedupes API replicas per namespace
 * and sums envs into the pool-wide series that dashboards and the (future)
 * KEDA ScaledObject read.
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
