import type { BuildLogEvent } from "./build-log-event";

/** Structured per-build summary recorded by {@link BuildLogSink.markFinished}. */
export interface BuildFinishSummary {
    /** The app that finished building - recorded as a low-cardinality Loki label for filtering. */
    app: string;
    /**
     * Which builder served the build - a low-cardinality Loki label dashboards
     * group by. Always "warm" now that the ephemeral per-build Jobs are gone;
     * kept so build-speed queries stay comparable with historical labels.
     */
    builder: "warm";
    /** Total build duration in milliseconds; the unwrapped metric value. */
    durationMs: number;
    /**
     * Milliseconds the build spent queued for a warm-pool slot before any
     * buildctl work started (0 when admitted instantly or the queue is off).
     * Included in `durationMs`; kept separate so build-speed queries can tell
     * pool saturation apart from genuinely slow builds.
     */
    queueWaitMs?: number;
    /**
     * The concrete buildkit endpoint that served the build - the granting
     * pool pod's address, or the shared Service host when the admission queue
     * is off. Kept in the line body (not a label) for detail; `builder` is
     * the label to group by.
     */
    host?: string;
}

/** Structured pool-saturation event recorded by {@link BuildLogSink.markQueueTimeout}. */
export interface QueueTimeoutSummary {
    /** The app whose build gave up waiting - recorded as a low-cardinality Loki label for filtering. */
    app: string;
    /** Milliseconds spent queued for a warm-pool slot before giving up; the unwrapped metric value. */
    queueWaitMs: number;
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
    /**
     * Record a pool-saturation event - a build that gave up waiting for a
     * warm-pool slot (queue timeout) - as a `kind="queue_timeout"` marker on
     * the build stream. Deliberately NOT a `finish` marker: build-speed
     * queries unwrap `durationMs` over `kind="finish"` and must not absorb
     * the waits of builds that never ran. Saturation queries read this stream
     * instead: `{source="build", kind="queue_timeout"} | json | unwrap
     * queueWaitMs`. Optional and best-effort like the rest of the sink.
     */
    markQueueTimeout?(environmentId: string, summary: QueueTimeoutSummary): Promise<void>;
    /** Mark the environment's stream finished (e.g. flush buffered lines). */
    seal(environmentId: string): Promise<void>;
    /** Drain buffers and stop timers; called on process shutdown. */
    close?(): Promise<void>;
}
