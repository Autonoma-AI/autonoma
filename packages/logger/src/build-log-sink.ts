import type { BuildLogEvent } from "./build-log-event";

/** Structured per-build summary recorded by {@link BuildLogSink.markFinished}. */
export interface BuildFinishSummary {
    /** The app that finished building - recorded as a low-cardinality Loki label for filtering. */
    app: string;
    /**
     * Which builder served the build - a low-cardinality Loki label dashboards
     * group by. New builds use isolated ephemeral buildkitd Jobs.
     */
    builder: "ephemeral";
    /** Total build duration in milliseconds; the unwrapped metric value. */
    durationMs: number;
    /**
     * The ephemeral buildkit pod endpoint that served the build. Kept in the
     * line body (not a label) for detail; `builder` is the label to group by.
     */
    host?: string;
}

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
    /**
     * Mark the start of a new build attempt for this environment. Successive
     * attempts (reruns, new commits) share one retention-bounded stream, so the
     * read side replays only from the latest marker - a new attempt's output
     * overwrites prior attempts in the viewer. Best-effort like the rest of the
     * sink; an outage here may never break the build.
     */
    markStart(environmentId: string): Promise<void>;
    /**
     * Mark the start of a new deployment for this environment, in the app-log
     * stream (`source="app"`) rather than the build stream. Runtime app logs are
     * scraped into one retention-bounded stream per environment, so the read side
     * replays a fresh app-log viewer only from the latest marker - a redeploy's
     * runtime output overwrites the prior deployment's lines in the viewer.
     * Best-effort like the rest of the sink; an outage here may never break the
     * deploy.
     */
    markDeploymentStart(environmentId: string): Promise<void>;
    /**
     * Record a structured per-build summary as a `kind="finish"` marker on the
     * build stream. Pure telemetry: the marker sits outside the display kinds
     * (`log`/`phase`/`status`) so the viewer never renders it, but build-speed
     * queries aggregate it (`{source="build", kind="finish"} | json | unwrap
     * durationMs`). Optional and best-effort like the rest of the sink.
     */
    markFinished?(environmentId: string, summary: BuildFinishSummary): Promise<void>;
    /** Mark the environment's stream finished (e.g. flush buffered lines). */
    seal(environmentId: string): Promise<void>;
    /** Drain buffers and stop timers; called on process shutdown. */
    close?(): Promise<void>;
}
