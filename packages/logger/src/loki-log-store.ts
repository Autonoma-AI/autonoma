import { z } from "zod";
import { type BuildLogEntry, BuildLogEventSchema } from "./build-log-event";
import type { LogStore } from "./log-store";
import { rootLogger } from "./logger-backend";

/**
 * Loki-backed implementation of the previewkit log relay.
 *
 * Reads one environment's log lines from Grafana Loki via `query_range`
 * behind the `LogStore` seam the apps/api SSE route polls. Nanosecond entry
 * timestamps are the SSE `Last-Event-ID` cursor, and resume is
 * `timestamp + 1ns`.
 *
 * The expected label set is written by the Alloy DaemonSet on the preview
 * cluster (app stdout/stderr) and, later, by the build pipeline's direct push:
 * `{namespace, source, app, stream, kind}` where `namespace` is the preview
 * environment's Kubernetes namespace and `source` is `app` or `build`.
 *
 * Known trade-off: two lines sharing an identical nanosecond timestamp are
 * both delivered, but a reconnect exactly between them drops the second
 * (cursor resume is ts+1). Acceptable for a log viewer; revisit if it ever
 * matters.
 */

const READ_LIMIT = 500;
// A fresh app-source viewer (cursor "0") tails the most recent lines inside
// this window rather than replaying the environment's full history - app
// streams are long-lived, so a full replay could be days of output.
const TAIL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// A fresh build-source viewer replays the whole build from the start. Builds
// are bounded, so the window only needs to cover how far back a build can be
// and still be queried - effectively the Loki retention_period (744h). Capped
// at 30 days because Loki rejects ranges over its default max_query_length
// (30d1h) with a 400.
const REPLAY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
// environmentId is interpolated into a LogQL selector; restricting it to the
// Kubernetes namespace charset makes escaping unnecessary.
const ENVIRONMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
// app is likewise interpolated into the selector; restrict to the charset of an
// app name / Kubernetes label value so escaping is unnecessary.
const APP_NAME_PATTERN = /^[a-zA-Z0-9._-]{1,63}$/;
// Loki cursors are decimal nanosecond timestamps. Anything else (e.g. a Redis
// Stream entry id replayed by a browser after the build store was flipped from
// Redis to Loki) is treated as a fresh viewer instead of an error.
const CURSOR_PATTERN = /^\d+$/;

const queryRangeResponseSchema = z.object({
    status: z.literal("success"),
    data: z.object({
        resultType: z.literal("streams"),
        result: z.array(
            z.object({
                stream: z.record(z.string(), z.string()),
                values: z.array(z.tuple([z.string(), z.string()])),
            }),
        ),
    }),
});

export class LokiLogStore implements LogStore {
    private readonly logger = rootLogger.child({ name: "LokiLogStore" });
    private readonly baseUrl: string;

    constructor(
        baseUrl: string,
        private readonly source: "build" | "app",
    ) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    /**
     * Read entries newer than `afterCursor` (a nanosecond timestamp string).
     * A fresh viewer (`"0"` or an unparseable foreign cursor) starts
     * per-source: app streams tail the newest READ_LIMIT lines inside a recent
     * window (mirroring `kubectl logs --tail`), build streams replay forward
     * from the beginning so the whole build is shown.
     */
    async readBatch(environmentId: string, afterCursor: string, app?: string): Promise<BuildLogEntry[]> {
        if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) {
            throw new Error(`Invalid environment id: ${environmentId}`);
        }
        if (app != null && !APP_NAME_PATTERN.test(app)) {
            throw new Error(`Invalid app name: ${app}`);
        }

        const nowNs = BigInt(Date.now()) * 1_000_000n;
        const isInitial = afterCursor === "0" || !CURSOR_PATTERN.test(afterCursor);
        const lookbackMs = this.source === "app" ? TAIL_LOOKBACK_MS : REPLAY_LOOKBACK_MS;
        const startNs = isInitial ? nowNs - BigInt(lookbackMs) * 1_000_000n : BigInt(afterCursor) + 1n;

        // An optional `app` narrows the stream to one app's lines (both sources carry the per-app
        // `app` label); without it the whole environment streams.
        const selector =
            app == null
                ? `{namespace="${environmentId}", source="${this.source}"}`
                : `{namespace="${environmentId}", source="${this.source}", app="${app}"}`;
        const params = new URLSearchParams({
            query: selector,
            start: startNs.toString(),
            end: nowNs.toString(),
            // App initial: backward + limit = the newest lines in the window
            // (tail). Everything else reads forward - build replays from the
            // start, and any non-initial poll resumes in order from the cursor.
            direction: isInitial && this.source === "app" ? "backward" : "forward",
            limit: String(READ_LIMIT),
        });

        const response = await fetch(`${this.baseUrl}/loki/api/v1/query_range?${params.toString()}`);
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Loki query_range failed: ${response.status} ${body}`);
        }
        const parsed = queryRangeResponseSchema.parse(await response.json());

        let dropped = 0;
        const entries: BuildLogEntry[] = [];
        for (const lokiStream of parsed.data.result) {
            const labels = lokiStream.stream;
            for (const [timestampNs, line] of lokiStream.values) {
                const event = BuildLogEventSchema.safeParse({
                    kind: labels["kind"] ?? "log",
                    app: emptyToUndefined(labels["app"]),
                    stream: emptyToUndefined(labels["stream"]),
                    message: line,
                });
                if (event.success) {
                    entries.push({ id: timestampNs, event: event.data });
                } else {
                    dropped++;
                }
            }
        }
        if (dropped > 0) {
            this.logger.debug("Dropped malformed Loki entries", { environmentId, source: this.source, dropped });
        }

        // Loki groups results per label-stream; the relay needs one ascending
        // timeline (this also flips the backward initial query into order).
        entries.sort(byEntryId);
        return entries;
    }
}

function emptyToUndefined(value: string | undefined): string | undefined {
    return value == null || value === "" ? undefined : value;
}

function byEntryId(a: BuildLogEntry, b: BuildLogEntry): number {
    const diff = BigInt(a.id) - BigInt(b.id);
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
}
