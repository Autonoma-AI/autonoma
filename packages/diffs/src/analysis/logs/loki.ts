import { causeMessage } from "@autonoma/errors";
import { z } from "zod";

/** A query for an app's logs over the run window, used to confirm whether an error blocked the failing step. */
export interface LokiLogQuery {
    /** Base URL of the Loki HTTP API (e.g. http://loki.autonoma.app:3100). */
    lokiBaseUrl: string;
    /** The preview env's k8s namespace (the log stream selector). */
    namespace: string;
    /** Run window start, in epoch SECONDS (padded internally). */
    startEpoch: number;
    /** Run window end, in epoch SECONDS (padded internally). */
    endEpoch: number;
    /** LogQL line filter (a regex). */
    regex: string;
    /** Max lines to return. */
    limit?: number;
    /**
     * Also return the build pipeline's output, not just the running app's. Defaults to false.
     *
     * A preview namespace carries both under the same `namespace` label (`loki-build-log-sink.ts` labels the
     * build stream `source="build"`), and a generic error filter matches build output readily: BuildKit step
     * lines, turbo cache output, and a `db-setup` shell one-liner whose `rejectUnauthorized` matches
     * `unauthorized`. Measured on a live preview over 24h, the unrestricted query returned 151 matching lines
     * of which 68 - 45% - were build output.
     *
     * Which side is noise depends on the question. Explaining why a RUNNING app failed a step wants the app
     * alone, or the model reads BuildKit output as the application's server-side errors. Diagnosing why a
     * deploy failed wants both, because the thing that failed is often the build itself.
     */
    includeBuildOutput?: boolean;
}

/** Drops the empty deployment-marker rows. `!=` also matches streams carrying no `kind` label, so no real line is lost. */
const DEPLOY_MARKER_MATCHER = 'kind!="start"';
/** Restricts the stream to the running app, excluding the build pipeline that shares the namespace. */
const APP_SOURCE_MATCHER = 'source="app"';

const DEFAULT_LIMIT = 150;
const WINDOW_PADDING_SECONDS = 90;
const REQUEST_TIMEOUT_MS = 25_000;
const NANOS_PER_SECOND = 1_000_000_000;

/**
 * Loki's `query_range` envelope, pinned rather than made optional.
 *
 * `status` and `resultType` are asserted for a reason: with them optional, a partial-error or
 * otherwise-unexpected payload parses cleanly to `undefined`, falls through to an empty result, and the
 * caller states it as the fact "the app emitted no matching error". A shape we do not recognise has to fail
 * loudly instead. Mirrors `LokiLogStore`'s schema in @autonoma/logger, which pins the same two fields.
 */
const LokiResponseSchema = z.object({
    status: z.literal("success"),
    data: z.object({
        resultType: z.literal("streams"),
        result: z.array(z.object({ values: z.array(z.tuple([z.string(), z.string()])) })),
    }),
});

/** One matched log line, with the nanosecond timestamp Loki returned alongside it. */
export interface LokiLogLine {
    /** Nanoseconds since the epoch, as a decimal string - it exceeds `Number.MAX_SAFE_INTEGER`. */
    timestampNs: string;
    line: string;
}

export interface LokiLogPage {
    lines: LokiLogLine[];
    /** The page filled the limit, so older matching lines exist that this query did not return. */
    truncated: boolean;
}

/**
 * Query an app's Loki logs over the run window, newest-first at the source and returned in ascending time
 * order.
 *
 * `direction` is sent explicitly rather than left to Loki's default. It decides which lines survive the
 * limit, and `backward` is deliberate: a truncated page should keep the lines CLOSEST to the failure, and a
 * run ends at or near the step that failed. The result is then sorted, because Loki groups its response per
 * label-stream - a namespace with more than one pod returns pod A's lines followed by pod B's, which is not
 * a timeline under any direction. Timestamps are kept so the caller can place each line against the run.
 */
export async function queryLokiLogs(query: LokiLogQuery): Promise<LokiLogPage> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const startNanos = (query.startEpoch - WINDOW_PADDING_SECONDS) * NANOS_PER_SECOND;
    const endNanos = (query.endEpoch + WINDOW_PADDING_SECONDS) * NANOS_PER_SECOND;
    const matchers =
        query.includeBuildOutput === true ? [DEPLOY_MARKER_MATCHER] : [APP_SOURCE_MATCHER, DEPLOY_MARKER_MATCHER];
    const params = new URLSearchParams({
        query: `{${matchers.join(", ")}, namespace="${query.namespace}"} |~ ${lineFilter(query.regex)}`,
        start: String(startNanos),
        end: String(endNanos),
        direction: "backward",
        limit: String(limit),
    });
    const url = `${query.lokiBaseUrl}/loki/api/v1/query_range?${params.toString()}`;

    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
        throw new Error(`Loki request failed: ${causeMessage(error)}`);
    }
    if (!response.ok) {
        throw new Error(`Loki returned HTTP ${response.status} for namespace ${query.namespace}`);
    }

    const body = LokiResponseSchema.parse(await response.json());
    const matched = body.data.result
        .flatMap((stream) => stream.values.map(([timestampNs, line]) => ({ timestampNs, line })))
        .sort(byTimestamp);
    // Trim from the FRONT, keeping the newest: the query asked for `backward`, so dropping the tail here
    // would discard exactly the lines nearest the failure that the direction was chosen to keep.
    return { lines: matched.slice(-limit), truncated: matched.length >= limit };
}

/**
 * The model's regex as a LogQL line filter it cannot break out of.
 *
 * A backtick string is RAW - a backtick cannot be escaped inside one - so a regex containing one either
 * fails the query outright or, worse, closes the literal and has its remainder parsed as more query: a stray
 * `` foo` |~ `bar `` becomes a VALID chain that silently ANDs two filters and returns fewer lines, which the
 * caller then states as "the app emitted no matching error". Loki's double-quoted form uses Go-style
 * escaping, a superset of JSON's, so `JSON.stringify` produces a literal in which quotes, backslashes and
 * backticks are all inert.
 *
 * Metacharacters are deliberately NOT escaped - unlike the search-term filter in @autonoma/logger, the input
 * here IS a regex and has to stay one. Verified against live Loki: identical results for a plain pattern,
 * `\s` still matches as a class, and an embedded backtick becomes a literal instead of a 400.
 */
function lineFilter(regex: string): string {
    return JSON.stringify(regex);
}

/** Ascending by nanosecond timestamp. BigInt because a nanosecond epoch overflows a JS number. */
function byTimestamp(a: LokiLogLine, b: LokiLogLine): number {
    const diff = BigInt(a.timestampNs) - BigInt(b.timestampNs);
    if (diff < 0n) return -1;
    return diff > 0n ? 1 : 0;
}
