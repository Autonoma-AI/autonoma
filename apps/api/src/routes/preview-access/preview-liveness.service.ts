import type { NamespaceLiveness, PreviewPowerState } from "@autonoma/k8s/preview-liveness";
import { logger as rootLogger, type Logger } from "@autonoma/logger";

// How long a whole-fleet snapshot is served before a fresh LIST. Many UI clients
// poll this behind list views; a few seconds of staleness coalesces them into
// one cluster read per window while still feeling live. Cheap either way - the
// read is a single label-filtered LIST, never a per-preview call.
//
// Best-effort and per-process: with multiple API replicas each keeps its own
// cache, so two pollers can land on different replicas and see snapshots up to a
// TTL apart. That is fine - liveness is advisory and eventually consistent (k8s
// state changes continuously anyway), nothing reads it transactionally. The only
// cost of more replicas is one extra LIST per replica per window.
const FLEET_CACHE_TTL_MS = 5_000;

// When the preview cluster can't be read, callers get this rather than an error:
// a missing liveness signal must degrade a list view, never break it.
export type PreviewLivenessState = PreviewPowerState | "unknown";

/** The one thing the service needs from a fleet client - kept structural so the caching logic is testable without a cluster. */
export interface FleetSource {
    listFleet(): Promise<Map<string, NamespaceLiveness>>;
}

/**
 * Serves per-namespace preview power/health state to the read-only tRPC layer,
 * caching one whole-fleet snapshot across the many concurrent list-view pollers.
 * Purely a read: it never wakes a preview.
 */
export class PreviewLivenessService {
    private readonly logger: Logger;
    private readonly now: () => number;
    private cache?: { at: number; fleet: Map<string, NamespaceLiveness> };
    private inFlight?: Promise<Map<string, NamespaceLiveness>>;

    constructor(
        private readonly source: FleetSource,
        now: () => number = Date.now,
    ) {
        this.logger = rootLogger.child({ name: "PreviewLivenessService" });
        this.now = now;
    }

    /**
     * The current fleet snapshot: the cached one while fresh, otherwise a single
     * refresh shared by every concurrent caller. Never throws - on a cluster read
     * failure it serves the last good snapshot (or an empty one), so a liveness
     * outage reads as "unknown" rather than failing the list view.
     */
    async getFleet(): Promise<Map<string, NamespaceLiveness>> {
        const cached = this.cache;
        if (cached != null && this.now() - cached.at < FLEET_CACHE_TTL_MS) return cached.fleet;
        if (this.inFlight != null) return await this.inFlight;

        this.inFlight = this.refresh();
        try {
            return await this.inFlight;
        } finally {
            this.inFlight = undefined;
        }
    }

    /** The power/health state for one namespace within a snapshot, or "unknown" if absent. */
    stateForNamespace(namespace: string, fleet: Map<string, NamespaceLiveness>): PreviewLivenessState {
        return fleet.get(namespace)?.state ?? "unknown";
    }

    private async refresh(): Promise<Map<string, NamespaceLiveness>> {
        try {
            const fleet = await this.source.listFleet();
            this.cache = { at: this.now(), fleet };
            return fleet;
        } catch (err) {
            this.logger.error("Failed to read preview fleet liveness; serving last snapshot", { extra: { err } });
            return this.cache?.fleet ?? new Map();
        }
    }
}
