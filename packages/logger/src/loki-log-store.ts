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
// A viewer's search term is a free-form substring, so it can't be charset-limited
// like the ids above. Cap its length (a search box, not a query language) and make
// it injection-proof by escaping regex metacharacters and embedding it in a Loki
// double-quoted string (see `lineFilter`), rather than trusting the input.
const FILTER_MAX_LENGTH = 200;

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
    async readBatch(
        environmentId: string,
        afterCursor: string,
        app?: string,
        filter?: string,
    ): Promise<BuildLogEntry[]> {
        if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) {
            throw new Error(`Invalid environment id: ${environmentId}`);
        }
        if (app != null && !APP_NAME_PATTERN.test(app)) {
            throw new Error(`Invalid app name: ${app}`);
        }
        if (filter != null && filter.length > FILTER_MAX_LENGTH) {
            throw new Error(`Filter too long: ${filter.length} > ${FILTER_MAX_LENGTH}`);
        }

        const nowNs = BigInt(Date.now()) * 1_000_000n;
        const isInitial = afterCursor === "0" || !CURSOR_PATTERN.test(afterCursor);
        const initial = isInitial ? await this.initialRead(environmentId, nowNs) : undefined;
        const startNs = initial?.startNs ?? BigInt(afterCursor) + 1n;

        // An optional `app` narrows the stream to one app's lines (both sources carry the per-app
        // `app` label); without it the whole environment streams. Both sources also exclude the
        // `kind="start"` markers - they are replay boundaries, not displayable lines. An optional
        // `filter` appends a case-insensitive line filter so the viewer can search server-side; it
        // is applied here only, never to the start-marker query, so the replay floor is always found
        // (a search over an empty result set must still resume from the right run).
        const selector = this.buildSelector(environmentId, app);
        const query = filter != null && filter !== "" ? `${selector} ${lineFilter(filter)}` : selector;
        const params = new URLSearchParams({
            query,
            start: startNs.toString(),
            end: nowNs.toString(),
            // `initialRead` chooses the fresh-viewer direction: forward to replay
            // from a start marker (latest build attempt / latest deployment),
            // backward to tail an unmarked app stream's newest lines. Any
            // non-initial poll resumes forward in order from the cursor.
            direction: initial?.direction ?? "forward",
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

    /**
     * Where a fresh viewer (cursor "0") starts reading, and in which direction.
     * Both sources scope to the latest `kind="start"` marker when one exists -
     * build to its latest attempt, app to its latest deployment - and replay
     * forward from there, so a rerun/redeploy's output overwrites the prior run
     * retained in this namespace's (retention-bounded) shared stream.
     *
     * With no marker (a stream that predates this feature, or is still mid-flight
     * before its marker lands) each source falls back to its window default:
     * build replays the whole bounded build forward; app tails the newest lines
     * backward, since its stream is long-lived and a full-window forward replay
     * could be days of output.
     */
    private async initialRead(
        environmentId: string,
        nowNs: bigint,
    ): Promise<{ startNs: bigint; direction: "forward" | "backward" }> {
        const lookbackMs = this.source === "app" ? TAIL_LOOKBACK_MS : REPLAY_LOOKBACK_MS;
        const windowStart = nowNs - BigInt(lookbackMs) * 1_000_000n;

        const markerNs = await this.latestStartMarkerNs(environmentId, windowStart, nowNs);
        if (markerNs != null) return { startNs: markerNs, direction: "forward" };

        return { startNs: windowStart, direction: this.source === "app" ? "backward" : "forward" };
    }

    /**
     * Timestamp of the newest start marker for this source in the window, or
     * undefined when none exists. A marker-query failure is non-fatal: it logs
     * and returns undefined so the caller falls back to the window default
     * rather than failing the whole read.
     */
    private async latestStartMarkerNs(
        environmentId: string,
        startNs: bigint,
        endNs: bigint,
    ): Promise<bigint | undefined> {
        const params = new URLSearchParams({
            query: `{namespace="${environmentId}", source="${this.source}", kind="start"}`,
            start: startNs.toString(),
            end: endNs.toString(),
            direction: "backward",
            limit: "1",
        });
        try {
            const response = await fetch(`${this.baseUrl}/loki/api/v1/query_range?${params.toString()}`);
            if (!response.ok) {
                const body = await response.text();
                this.logger.warn("Loki start-marker query failed; falling back to window default", {
                    environmentId,
                    source: this.source,
                    status: response.status,
                    body,
                });
                return undefined;
            }
            const parsed = queryRangeResponseSchema.parse(await response.json());
            let latest: bigint | undefined;
            for (const lokiStream of parsed.data.result) {
                for (const [timestampNs] of lokiStream.values) {
                    const ts = BigInt(timestampNs);
                    if (latest == null || ts > latest) latest = ts;
                }
            }
            return latest;
        } catch (err) {
            this.logger.warn("Loki start-marker query errored; falling back to window default", {
                environmentId,
                source: this.source,
                err,
            });
            return undefined;
        }
    }

    /**
     * Build the LogQL selector. An optional `app` narrows to one app's lines.
     * Both sources exclude the `kind="start"` markers (`initialRead` already
     * consumed the latest as the replay floor) so they never reach the viewer or
     * inflate the malformed-line drop count. The `!=` matcher still selects
     * streams with no `kind` label (Alloy-scraped app lines), since a missing
     * label reads as empty - only the explicit `start` markers are dropped.
     */
    private buildSelector(environmentId: string, app?: string): string {
        const matchers = [`namespace="${environmentId}"`, `source="${this.source}"`];
        if (app != null) matchers.push(`app="${app}"`);
        matchers.push(`kind!="start"`);
        return `{${matchers.join(", ")}}`;
    }
}

/**
 * A LogQL line filter matching lines that contain `term` as a case-insensitive substring.
 *
 * `term` is untrusted (a viewer's search box), so it is made safe in two layers before it
 * reaches Loki: regex metacharacters are escaped so the term matches literally rather than as
 * a pattern, then the result is embedded via `JSON.stringify` in Loki's double-quoted string
 * form (`|~ "..."`), whose Go-style escaping is a superset of JSON's - so quotes, backslashes,
 * and backticks can never break out of the string. The `(?i)` flag makes the match
 * case-insensitive, which is what a search box implies.
 */
function lineFilter(term: string): string {
    const literal = `(?i)${escapeRegExp(term)}`;
    return `|~ ${JSON.stringify(literal)}`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
