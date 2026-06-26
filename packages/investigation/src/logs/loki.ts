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
}

const DEFAULT_LIMIT = 150;
const WINDOW_PADDING_SECONDS = 90;
const REQUEST_TIMEOUT_MS = 25_000;
const NANOS_PER_SECOND = 1_000_000_000;

const LokiResponseSchema = z.object({
    data: z
        .object({
            result: z.array(z.object({ values: z.array(z.tuple([z.string(), z.string()])) })).optional(),
        })
        .optional(),
});

/**
 * Query an app's Loki logs over the run window. Replaces the prototype's `curl` shell-out with `fetch`
 * (wrapped in try/catch because a network failure throws), and validates the response shape with zod at
 * the boundary instead of trusting `JSON.parse`. Throws on a network/HTTP failure; the caller decides how
 * to surface that to the model.
 */
export async function queryLokiLogs(query: LokiLogQuery): Promise<string[]> {
    const limit = query.limit ?? DEFAULT_LIMIT;
    const startNanos = (query.startEpoch - WINDOW_PADDING_SECONDS) * NANOS_PER_SECOND;
    const endNanos = (query.endEpoch + WINDOW_PADDING_SECONDS) * NANOS_PER_SECOND;
    const params = new URLSearchParams({
        query: `{namespace="${query.namespace}"} |~ \`${query.regex}\``,
        start: String(startNanos),
        end: String(endNanos),
        limit: String(limit),
    });
    const url = `${query.lokiBaseUrl}/loki/api/v1/query_range?${params.toString()}`;

    let response: Response;
    try {
        response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
        throw new Error(`Loki request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
        throw new Error(`Loki returned HTTP ${response.status} for namespace ${query.namespace}`);
    }

    const body = LokiResponseSchema.parse(await response.json());
    const streams = body.data?.result ?? [];
    return streams.flatMap((stream) => stream.values.map(([, line]) => line)).slice(0, limit);
}
