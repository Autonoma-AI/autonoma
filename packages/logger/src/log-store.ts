import type { BuildLogEntry } from "./build-log-event";

/**
 * Read side of the previewkit log relay. The apps/api SSE route polls
 * `readBatch` with the last delivered entry id and forwards entries to the
 * browser; `"0"` means "fresh viewer" and replays whatever history the backing
 * store retains. Entry ids double as SSE `Last-Event-ID` cursors, so they must
 * be monotonically increasing and resumable.
 *
 * Implemented by `LokiLogStore` (Grafana Loki) for both sources: build output
 * pushed by previewkit's `LokiBuildLogSink` and app stdout/stderr collected
 * from preview pods by the Alloy DaemonSet.
 */
export interface LogStore {
    /**
     * `app`, when set, narrows the stream to one app's lines (both sources carry an `app` label).
     * `filter`, when set, is a case-insensitive substring the entry's message must contain
     * (applied as a Loki line filter server-side) so a viewer can search without pulling every line.
     */
    readBatch(environmentId: string, afterCursor: string, app?: string, filter?: string): Promise<BuildLogEntry[]>;
}
