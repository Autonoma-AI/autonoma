import { type EventSourceMessage, EventStreamContentType, fetchEventSource } from "@microsoft/fetch-event-source";
import { useEffect, useState } from "react";
import { z } from "zod";

/**
 * One entry from the build-log stream. Flat (not a discriminated union) to keep
 * accumulation simple. Mirrors the server's `BuildLogEvent`
 * (@autonoma/logger/build-log-event, relayed by the apps/api SSE route), tagged
 * with the server-side entry id (a Loki nanosecond timestamp) - which is
 * replayed as `Last-Event-Id` on reconnect so the stream resumes without gaps.
 */
export interface BuildLogEntry {
    id: string;
    kind: "log" | "phase" | "status";
    /** Present on `log` entries (build output is per-app); absent on phase/status. */
    app?: string;
    /** stdout | stderr for app-log entries (`?source=app`); absent on build output. */
    stream?: "stdout" | "stderr";
    message: string;
}

export type BuildLogConnection = "connecting" | "open" | "reconnecting" | "closed";

export interface BuildLogStreamState {
    /** Ordered entries as they arrive, capped to the most recent MAX_ENTRIES. */
    entries: BuildLogEntry[];
    /** Latest pipeline phase (`cloning`, `building-images`, ...), if seen. */
    phase?: string | undefined;
    /** Terminal build status once the stream completes (`ready` | `failed` | ...). */
    buildStatus?: string | undefined;
    /** Live connection state. `reconnecting` is normal - the transport auto-retries. */
    connection: BuildLogConnection;
    /** Set when the stream fails fatally (bad auth/HTTP) or the server gives up. */
    error?: string | undefined;
}

export interface UseBuildLogStreamOptions {
    /** Fully-formed SSE endpoint URL. When undefined, no stream is opened. */
    url?: string | undefined;
    /**
     * Extra request headers, e.g. `{ Authorization: "Bearer <token>" }`. This is
     * the reason we use fetch-event-source over native EventSource - it can send
     * an auth header, which the previewkit stream route requires. Pass a stable
     * reference (inline literals are fine - React Compiler memoizes them).
     */
    headers?: Record<string, string> | undefined;
    /** fetch credentials mode. Defaults to "include" so session cookies also flow. */
    credentials?: RequestCredentials | undefined;
}

/** Server event payload for `log` / `phase` / `status` events (the `data:` JSON). */
const streamEventSchema = z.object({
    kind: z.enum(["log", "phase", "status"]),
    app: z.string().optional(),
    stream: z.enum(["stdout", "stderr"]).optional(),
    message: z.string(),
});

/** Bound the in-memory buffer; matches the server stream's MAXLEN so a long build can't grow unbounded. */
const MAX_ENTRIES = 5000;

/** Thrown to stop fetch-event-source permanently (no retry) on a non-recoverable condition. */
class FatalStreamError extends Error {}

/**
 * Subscribes to a build-log SSE stream and accumulates its entries.
 *
 * Uses `@microsoft/fetch-event-source` rather than native `EventSource` so the
 * request can carry an `Authorization` header (the `/v1/previewkit/*` stream
 * route is API-key / service-authed). It still auto-reconnects and replays the
 * `Last-Event-Id` cursor, which the server honors, so drops self-heal.
 *
 * This is a genuine subscription side effect (not tRPC data), so unlike the rest
 * of the app it lives in `useEffect` - the one place that is the correct tool.
 */
export function useBuildLogStream({
    url,
    headers,
    credentials = "include",
}: UseBuildLogStreamOptions): BuildLogStreamState {
    const [entries, setEntries] = useState<BuildLogEntry[]>([]);
    const [phase, setPhase] = useState<string>();
    const [buildStatus, setBuildStatus] = useState<string>();
    const [connection, setConnection] = useState<BuildLogConnection>("connecting");
    const [error, setError] = useState<string>();

    useEffect(() => {
        if (url == null) {
            setConnection("closed");
            return;
        }

        // Reset accumulated state when the target stream changes.
        setEntries([]);
        setPhase(undefined);
        setBuildStatus(undefined);
        setError(undefined);
        setConnection("connecting");

        const controller = new AbortController();
        let fallbackSeq = 0;

        const append = (entry: BuildLogEntry) => {
            setEntries((prev) => {
                const next = [...prev, entry];
                return next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next;
            });
        };

        const onMessage = (message: EventSourceMessage) => {
            if (message.event === "done") {
                setBuildStatus(message.data);
                setConnection("closed");
                controller.abort();
                return;
            }
            if (message.event === "error") {
                setError(message.data.length > 0 ? message.data : "stream error");
                setConnection("closed");
                controller.abort();
                return;
            }
            if (message.event !== "log" && message.event !== "phase" && message.event !== "status") {
                return; // heartbeat / unnamed: ignore
            }

            const parsed = parseStreamData(message.data);
            if (parsed == null) return;
            if (parsed.kind === "phase") setPhase(parsed.message);

            const entry: BuildLogEntry = {
                id: message.id.length > 0 ? message.id : `seq-${fallbackSeq++}`,
                kind: parsed.kind,
                message: parsed.message,
            };
            if (parsed.app != null) entry.app = parsed.app;
            if (parsed.stream != null) entry.stream = parsed.stream;
            append(entry);
        };

        void fetchEventSource(url, {
            signal: controller.signal,
            credentials,
            openWhenHidden: true, // keep streaming when the tab is backgrounded
            ...(headers != null ? { headers } : {}),
            onopen: async (response) => {
                const contentType = response.headers.get("content-type") ?? "";
                if (response.ok && contentType.includes(EventStreamContentType)) {
                    setConnection("open");
                    return;
                }
                // 4xx/5xx or wrong content type - not recoverable, don't retry.
                setError(`build log stream unavailable (HTTP ${response.status})`);
                setConnection("closed");
                throw new FatalStreamError();
            },
            onmessage: onMessage,
            onclose: () => {
                // Server ended the stream without a terminal event; stop (no retry).
                setConnection("closed");
                throw new FatalStreamError();
            },
            onerror: (err) => {
                // Aborted (unmount / done / fatal) or fatal -> rethrow to stop.
                if (controller.signal.aborted || err instanceof FatalStreamError) throw err;
                // Transient network error -> reflect and let the library retry.
                setConnection("reconnecting");
            },
        }).catch(() => {
            // The promise rejects on abort or fatal error; state is already set.
            // Swallow so it doesn't surface as an unhandled rejection.
        });

        return () => controller.abort();
    }, [url, headers, credentials]);

    return { entries, phase, buildStatus, connection, error };
}

/** Parse + validate an SSE `data:` payload; drops anything malformed rather than throwing. */
function parseStreamData(raw: string): z.infer<typeof streamEventSchema> | undefined {
    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return undefined;
    }
    const result = streamEventSchema.safeParse(json);
    return result.success ? result.data : undefined;
}
