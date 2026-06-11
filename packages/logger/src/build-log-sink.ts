import type { BuildLogEvent } from "./build-log-event";

/**
 * Write side of the previewkit build-log relay - the producer-facing mirror of
 * the read-side `LogStore`. The build pipeline appends raw output chunks,
 * phase transitions, and the terminal status through this seam, then `seal`s
 * the environment's stream when the build ends.
 *
 * Implemented by `LokiBuildLogSink` (Grafana Loki). Implementations must be
 * best-effort: a sink outage may never break the build it observes, so errors
 * are logged and swallowed inside the sink.
 */
export interface BuildLogSink {
    append(environmentId: string, event: BuildLogEvent): Promise<void>;
    /** Mark the environment's stream finished (e.g. flush buffered lines). */
    seal(environmentId: string): Promise<void>;
    /** Drain buffers and stop timers; called on process shutdown. */
    close?(): Promise<void>;
}
