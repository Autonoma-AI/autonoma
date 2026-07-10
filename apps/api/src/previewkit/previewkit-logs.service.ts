import { type Logger, logger as rootLogger } from "@autonoma/logger";
import type { LokiLogStore } from "@autonoma/logger/loki-log-store";
import type { PreviewkitEnvironmentsService } from "./previewkit-environments.service";

/** Default number of tail lines returned when a caller does not specify one. */
const DEFAULT_TAIL_LINES = 200;
// Aggregate cap on the bytes returned in one tail. Individual lines are never
// truncated - a huge one-line JSON blob comes back whole - but if the total
// exceeds this budget, whole lines are dropped from the far end (the oldest when
// tailing, the newest when reading from the head) and `truncated` is set, so a
// pathological volume can't blow up memory or a model's context.
const MAX_TOTAL_LOG_BYTES = 1_000_000;

/** The `LokiLogStore` capability this service needs; narrowed so tests can inject a fake. */
type TailLogStore = Pick<LokiLogStore, "readLastN">;

export type PreviewLogSource = "build" | "app";

/** One flattened log line, agent-friendly (no cursor/id plumbing). */
export interface PreviewLogLine {
    /** Loki nanosecond timestamp, as a string (preserves precision). */
    timestampNs: string;
    message: string;
    app?: string;
    stream?: string;
    kind: string;
}

export interface PreviewLogsResult {
    /** False when log streaming is not configured (PREVIEWKIT_LOKI_URL unset) - lines is then empty. */
    available: boolean;
    source: PreviewLogSource;
    reason?: string;
    lines: PreviewLogLine[];
    /**
     * Distinct services (app names) that appear in the returned lines. Previews are
     * multi-service (e.g. "web" + "db") and logs are labelled per service; omitting
     * `app` returns all of them (this list shows which produced output), while
     * passing `app` narrows to one. An empty list on an empty result means the
     * window genuinely had no output - not that the query was mis-scoped.
     */
    services: string[];
    /** True when whole lines were dropped to stay under the total byte budget (line content is never cut). */
    truncated?: boolean;
}

/**
 * Reads a bounded "last N lines" snapshot of a preview environment's build or app
 * logs from Loki, for non-streaming consumers (the MCP `get_build_logs` /
 * `get_app_logs` tools). It resolves the (repoFullName, prNumber) pair to the
 * environment's Loki namespace via {@link PreviewkitEnvironmentsService} - applying
 * the same org-scoping as the SSE stream - then delegates the tail to the
 * source-specific {@link LokiLogStore}. Returns `available: false` (never throws)
 * when Loki is not configured, mirroring the SSE route's 503.
 */
export class PreviewkitLogsService {
    private readonly logger: Logger;

    constructor(
        private readonly environments: PreviewkitEnvironmentsService,
        private readonly buildLogStore: TailLogStore | undefined,
        private readonly appLogStore: TailLogStore | undefined,
    ) {
        this.logger = rootLogger.child({ name: this.constructor.name });
    }

    async tail(params: {
        repoFullName: string;
        prNumber: number;
        source: PreviewLogSource;
        callerOrgId: string | undefined;
        app?: string;
        limit?: number;
        filter?: string;
        /** Which end of the stream to read: "tail" (newest, default) or "head" (from the run's start). */
        from?: "head" | "tail";
    }): Promise<PreviewLogsResult | undefined> {
        const { repoFullName, prNumber, source, callerOrgId, app, filter, from } = params;
        const limit = params.limit ?? DEFAULT_TAIL_LINES;
        this.logger.info("Tailing preview logs", { repoFullName, prNumber, extra: { source, limit, app, from } });

        const store = source === "app" ? this.appLogStore : this.buildLogStore;
        if (store == null) {
            return { available: false, source, reason: "Log streaming is not configured.", lines: [], services: [] };
        }

        const target = await this.environments.resolveStreamTarget(repoFullName, prNumber, callerOrgId);
        // Undefined (not an empty result) signals "no such environment / not yours",
        // which the tool maps to a not-found - distinct from a configured-but-empty tail.
        if (target == null) return undefined;

        const entries = await store.readLastN(target.namespace, limit, { app, filter, from });
        const allLines: PreviewLogLine[] = entries.map((entry) => ({
            timestampNs: entry.id,
            message: entry.event.message,
            app: entry.event.app,
            stream: entry.event.stream,
            kind: entry.event.kind,
        }));
        const { lines, truncated } = applyByteBudget(allLines, from ?? "tail", MAX_TOTAL_LOG_BYTES);
        const services = [...new Set(lines.map((line) => line.app).filter((app): app is string => app != null))].sort();

        this.logger.info("Preview logs read", {
            repoFullName,
            prNumber,
            extra: { source, lineCount: lines.length, truncated, serviceCount: services.length },
        });
        return { available: true, source, lines, services, truncated };
    }
}

/**
 * Trim a full-fidelity, ascending list of log lines to a total byte budget by
 * dropping whole lines from the low-priority end - the oldest when tailing, the
 * newest when reading from the head - so the requested end is always kept intact.
 * Line content is never cut; a single line that alone exceeds the budget is still
 * returned in full rather than an empty result.
 */
function applyByteBudget(
    lines: PreviewLogLine[],
    from: "head" | "tail",
    maxBytes: number,
): { lines: PreviewLogLine[]; truncated: boolean } {
    let total = 0;
    const kept: PreviewLogLine[] = [];
    // Walk from the priority end: forward for head (keep oldest), backward for tail (keep newest).
    const indices = from === "head" ? range(0, lines.length, 1) : range(lines.length - 1, -1, -1);
    for (const i of indices) {
        const line = lines[i];
        if (line == null) continue;
        total += Buffer.byteLength(line.message, "utf8");
        if (total > maxBytes && kept.length > 0) {
            return { lines: from === "head" ? kept : kept.reverse(), truncated: true };
        }
        kept.push(line);
    }
    return { lines: from === "head" ? kept : kept.reverse(), truncated: false };
}

/** Integer indices from `start` (inclusive) to `end` (exclusive) stepping by `step`. */
function range(start: number, end: number, step: number): number[] {
    const out: number[] = [];
    for (let i = start; step > 0 ? i < end : i > end; i += step) out.push(i);
    return out;
}
