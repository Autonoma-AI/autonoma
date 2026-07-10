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
// Hard cap on how many lines a single `readLastN` tail can request, so a caller
// (e.g. an MCP tool) can never ask Loki for an unbounded page. Line content is
// never truncated - a huge one-line JSON blob comes back whole - so the returned
// payload is bounded by this line count; a caller feeding a model's context
// window can bound it further with a lower `limit` or an aggregate byte budget.
const MAX_TAIL_LINES = 1000;
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
// Ceiling on the raw bytes pulled from a single Loki `query_range` response before
// it is parsed. `response.json()` materializes the entire body in the API heap
// first, so a pathological response - one enormous single-line blob, or a runaway
// result set - could exhaust process memory regardless of the line-count limit
// (which bounds line *count*, never line *size*). `queryRange` streams the body
// through a running byte count and aborts past this ceiling, so an oversized
// response fails loudly instead of OOMing the process. Sized well above a
// legitimate 1000-line page of realistic lines, but far below memory pressure.
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

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
        // Validate before `initialRead`, which interpolates environmentId into a
        // Loki marker query - the check must happen ahead of any Loki call.
        this.validateInputsOrThrow(environmentId, app, filter);

        const nowNs = BigInt(Date.now()) * 1_000_000n;
        const isInitial = afterCursor === "0" || !CURSOR_PATTERN.test(afterCursor);
        const initial = isInitial ? await this.initialRead(environmentId, nowNs) : undefined;
        const startNs = initial?.startNs ?? BigInt(afterCursor) + 1n;

        // `initialRead` chooses the fresh-viewer direction: forward to replay from a
        // start marker (latest build attempt / latest deployment), backward to tail
        // an unmarked app stream's newest lines. Any non-initial poll resumes forward
        // in order from the cursor.
        return this.runQueryRange({
            environmentId,
            startNs,
            endNs: nowNs,
            direction: initial?.direction ?? "forward",
            limit: READ_LIMIT,
            app,
            filter,
        });
    }

    /**
     * Read a bounded `limit`-line snapshot for this source, returned in ascending
     * time order. Unlike {@link readBatch}, this is a one-shot pull (no cursor
     * replay) meant for callers that want a fixed window - e.g. an MCP tool feeding
     * a client's agent - rather than a live SSE tail. `from` picks which end of the
     * stream: `"tail"` (default) selects the newest `limit` lines (the crash / most
     * recent output); `"head"` selects the oldest `limit` from the run's start (the
     * beginning of a build / startup), so a caller can page to either end. `app`
     * narrows to one app's lines and `filter` applies the same injection-proof
     * case-insensitive substring search. Line content is returned in full - a
     * caller that must bound total size does so with `limit` or its own budget.
     */
    async readLastN(
        environmentId: string,
        limit: number,
        options: { app?: string; filter?: string; from?: "head" | "tail" } = {},
    ): Promise<BuildLogEntry[]> {
        const { app, filter, from = "tail" } = options;
        // Validate before `readWindow` (which may call `initialRead`), so no invalid
        // environmentId ever reaches a Loki query.
        this.validateInputsOrThrow(environmentId, app, filter);

        const cappedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_TAIL_LINES));
        const nowNs = BigInt(Date.now()) * 1_000_000n;

        // "head" replays forward from the run's start (the latest start marker, or
        // the window floor when none exists); "tail" selects the newest lines by
        // scanning backward from now. Both re-sort ascending below.
        const window = await this.readWindow(environmentId, nowNs, from);

        return this.runQueryRange({
            environmentId,
            startNs: window.startNs,
            endNs: nowNs,
            direction: window.direction,
            limit: cappedLimit,
            app,
            filter,
        });
    }

    /**
     * Shared executor behind {@link readBatch} and {@link readLastN}: build the
     * source-aware selector (+ optional app narrowing and case-insensitive line
     * filter), run one bounded `query_range` page, and return the entries in one
     * ascending timeline. The two public methods differ only in how they compute
     * `startNs` / `direction` / `limit`; everything downstream is identical here.
     *
     * An optional `app` narrows the stream to one app's lines (both sources carry
     * the per-app `app` label); without it the whole environment streams. Both
     * sources exclude the `kind="start"` markers - they are replay boundaries, not
     * displayable lines. An optional `filter` appends a case-insensitive line
     * filter so a viewer can search server-side.
     */
    private async runQueryRange(opts: {
        environmentId: string;
        startNs: bigint;
        endNs: bigint;
        direction: "forward" | "backward";
        limit: number;
        app?: string;
        filter?: string;
    }): Promise<BuildLogEntry[]> {
        const { environmentId, startNs, endNs, direction, limit, app, filter } = opts;

        // Self-guard the LogQL interpolation: `buildSelector` embeds environmentId
        // and app raw into double-quoted matchers, so this method must not trust its
        // (private) callers to have validated. The public entry points also validate
        // to fail fast before I/O; re-checking here keeps the guard co-located with
        // the interpolation, so a future caller can never reopen query injection.
        this.validateInputsOrThrow(environmentId, app, filter);

        const selector = this.buildSelector(environmentId, app);
        const query = filter != null && filter !== "" ? `${selector} ${lineFilter(filter)}` : selector;
        const params = new URLSearchParams({
            query,
            start: startNs.toString(),
            end: endNs.toString(),
            direction,
            limit: String(limit),
        });

        const parsed = await this.queryRange(params);

        const { entries, dropped } = this.parseEntries(parsed.data.result);
        if (dropped > 0) {
            this.logger.debug("Dropped malformed Loki entries", { environmentId, source: this.source, dropped });
        }

        // Loki groups results per label-stream; callers need one ascending timeline
        // (this also flips a backward tail/initial query into order).
        entries.sort(byEntryId);
        return entries;
    }

    /**
     * Fetch one Loki `query_range` page with a memory-bounded body read, then
     * validate it. `readBoundedBody` streams the response through a byte counter
     * and aborts past {@link MAX_RESPONSE_BYTES}, so a pathological response can
     * never be fully materialized in the API heap (which a plain `response.json()`
     * would do before any line-count or byte budget downstream could apply).
     */
    private async queryRange(params: URLSearchParams): Promise<z.infer<typeof queryRangeResponseSchema>> {
        const response = await fetch(`${this.baseUrl}/loki/api/v1/query_range?${params.toString()}`);
        if (!response.ok) {
            const body = await response.text();
            throw new Error(`Loki query_range failed: ${response.status} ${body}`);
        }
        const text = await this.readBoundedBody(response);
        return queryRangeResponseSchema.parse(JSON.parse(text));
    }

    /**
     * Read a fetch `Response` body as text, aborting once it exceeds
     * {@link MAX_RESPONSE_BYTES}. `response.json()` / `response.text()` buffer the
     * whole body before returning, so an enormous line or a runaway result set
     * would be fully in-heap first; streaming through a running byte count lets us
     * cancel and throw the moment it crosses the ceiling, bounding memory at ingest.
     */
    private async readBoundedBody(response: Response): Promise<string> {
        const body = response.body;
        if (body == null) {
            // No readable stream (a non-streaming fetch polyfill); fall back to a
            // buffered read, still enforcing the ceiling on the materialized text.
            const text = await response.text();
            if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
                throw new Error(`Loki response exceeded ${MAX_RESPONSE_BYTES} bytes`);
            }
            return text;
        }

        const reader = body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value == null) continue;
                total += value.byteLength;
                if (total > MAX_RESPONSE_BYTES) {
                    throw new Error(`Loki response exceeded ${MAX_RESPONSE_BYTES} bytes`);
                }
                chunks.push(value);
            }
        } finally {
            // Cancel on the throw path to free the connection; a no-op once fully read.
            await reader.cancel().catch((err) => {
                this.logger.debug("Failed cancelling Loki response stream", { source: this.source, err });
            });
        }
        return Buffer.concat(chunks).toString("utf8");
    }

    /** Reject inputs that would be unsafe to interpolate into a LogQL query. */
    private validateInputsOrThrow(environmentId: string, app?: string, filter?: string): void {
        this.validateEnvironmentIdOrThrow(environmentId);
        if (app != null && !APP_NAME_PATTERN.test(app)) {
            throw new Error(`Invalid app name: ${app}`);
        }
        if (filter != null && filter.length > FILTER_MAX_LENGTH) {
            throw new Error(`Filter too long: ${filter.length} > ${FILTER_MAX_LENGTH}`);
        }
    }

    /**
     * Reject an environmentId that would be unsafe to interpolate into a LogQL
     * selector. Called at every interpolation site (not only the public entry
     * points), since environmentId is embedded raw into `namespace="..."`.
     */
    private validateEnvironmentIdOrThrow(environmentId: string): void {
        if (!ENVIRONMENT_ID_PATTERN.test(environmentId)) {
            throw new Error(`Invalid environment id: ${environmentId}`);
        }
    }

    /** Start timestamp + scan direction for a `readLastN` window, per `from`. */
    private async readWindow(
        environmentId: string,
        nowNs: bigint,
        from: "head" | "tail",
    ): Promise<{ startNs: bigint; direction: "forward" | "backward" }> {
        if (from === "head") {
            const initial = await this.initialRead(environmentId, nowNs);
            return { startNs: initial.startNs, direction: "forward" };
        }
        // A one-shot snapshot tails the newest lines regardless of age, so it scans
        // the full retention window - NOT the 24h live-viewer window. An idle
        // preview whose only output is its multi-day-old startup would otherwise
        // fall outside a 24h tail and return empty, which reads as "no logs".
        return { startNs: nowNs - BigInt(REPLAY_LOOKBACK_MS) * 1_000_000n, direction: "backward" };
    }

    /** Parse Loki `query_range` streams into `BuildLogEntry`s, counting malformed lines dropped. */
    private parseEntries(result: { stream: Record<string, string>; values: [string, string][] }[]): {
        entries: BuildLogEntry[];
        dropped: number;
    } {
        let dropped = 0;
        const entries: BuildLogEntry[] = [];
        for (const lokiStream of result) {
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
        return { entries, dropped };
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
        // environmentId is embedded raw into the selector below; guard it here too
        // (before the try, so a bad id throws instead of being swallowed as a
        // benign marker-miss). Reached only post-validation today - defense in depth.
        this.validateEnvironmentIdOrThrow(environmentId);
        const params = new URLSearchParams({
            query: `{namespace="${environmentId}", source="${this.source}", kind="start"}`,
            start: startNs.toString(),
            end: endNs.toString(),
            direction: "backward",
            limit: "1",
        });
        try {
            const parsed = await this.queryRange(params);
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
