import type { BuildLogEvent } from "./build-log-event";
import type { BuildFinishSummary, BuildLogSink } from "./build-log-sink";
import { rootLogger } from "./logger-backend";

/**
 * Pushes build-log events to Grafana Loki. Events are buffered and flushed in
 * batches (interval or size triggered); `seal` flushes immediately so the
 * terminal status line lands without waiting out the interval, and `close`
 * drains on shutdown.
 *
 * The label set mirrors what the Alloy DaemonSet writes for app logs, with
 * `source="build"`: `{namespace, source, kind, app?}` - exactly what the
 * API-side `LokiLogStore("build")` queries by.
 *
 * Best-effort by contract (see `BuildLogSink`): a failed push logs a warning
 * with the dropped line count and never throws into the build.
 */

const FLUSH_INTERVAL_MS = 1000;
// Size backstop so a very chatty build flushes mid-interval instead of
// accumulating an unbounded buffer.
const MAX_BUFFERED_LINES = 1000;

interface BufferedLine {
    labels: Record<string, string>;
    tsNs: string;
    line: string;
}

interface LokiStreamPayload {
    stream: Record<string, string>;
    values: [string, string][];
}

export class LokiBuildLogSink implements BuildLogSink {
    private readonly logger = rootLogger.child({ name: "LokiBuildLogSink" });
    private readonly baseUrl: string;
    private readonly timer: NodeJS.Timeout;
    private buffer: BufferedLine[] = [];
    private lastTsNs = 0n;

    constructor(baseUrl: string) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.timer = setInterval(() => {
            void this.flush();
        }, FLUSH_INTERVAL_MS);
        // Never keep the process alive just to flush logs.
        this.timer.unref();
    }

    /** Buffer one event (raw output chunk, phase transition, or terminal status). */
    append(environmentId: string, event: BuildLogEvent): Promise<void> {
        const labels: Record<string, string> = { namespace: environmentId, source: "build", kind: event.kind };
        if (event.app != null) labels["app"] = event.app;
        if (event.stream != null) labels["stream"] = event.stream;

        this.bufferLine(labels, event.message);
        if (this.buffer.length >= MAX_BUFFERED_LINES) void this.flush();
        return Promise.resolve();
    }

    /**
     * Push a `kind="start"` sentinel marking a new build attempt, then flush
     * immediately so a viewer connecting at build start resolves the new replay
     * floor without waiting out the batch interval. The marker carries a kind
     * outside the display set (`log`/`phase`/`status`), so the read side uses it
     * purely as a boundary and never surfaces it as a log line.
     */
    async markStart(environmentId: string): Promise<void> {
        this.bufferLine({ namespace: environmentId, source: "build", kind: "start" }, "");
        await this.flush();
    }

    /**
     * Push a `kind="start"` sentinel into the environment's app-log stream
     * (`source="app"`) marking a new deployment, then flush immediately so a
     * viewer connecting as the deploy starts resolves the new replay floor
     * without waiting out the batch interval. Mirrors {@link markStart} but
     * targets the runtime app stream (scraped from pods by the Alloy DaemonSet)
     * instead of the build stream. The marker's kind sits outside the display set
     * (`log`/`phase`/`status`), so the read side uses it purely as a boundary and
     * never surfaces it as a log line.
     */
    async markDeploymentStart(environmentId: string): Promise<void> {
        this.bufferLine({ namespace: environmentId, source: "app", kind: "start" }, "");
        await this.flush();
    }

    /**
     * Push a `kind="finish"` marker carrying a JSON build summary, then flush so
     * the metric lands promptly. The kind sits outside the display set
     * (`log`/`phase`/`status`), so the read side never surfaces it as a log
     * line; build-speed queries read it with `| json | unwrap durationMs`.
     */
    async markFinished(environmentId: string, summary: BuildFinishSummary): Promise<void> {
        const line = JSON.stringify({ durationMs: summary.durationMs, app: summary.app, host: summary.host });
        this.bufferLine({ namespace: environmentId, source: "build", kind: "finish" }, line);
        await this.flush();
    }

    /**
     * Buffer one line with a monotonic nanosecond timestamp (now, bumped by 1ns
     * on same-millisecond appends) so per-build ordering survives Loki's
     * timestamp-based reads.
     */
    private bufferLine(labels: Record<string, string>, line: string): void {
        const nowNs = BigInt(Date.now()) * 1_000_000n;
        this.lastTsNs = nowNs > this.lastTsNs ? nowNs : this.lastTsNs + 1n;
        this.buffer.push({ labels, tsNs: this.lastTsNs.toString(), line });
    }

    /**
     * Loki has no per-stream TTL - the server-side retention period reclaims
     * old streams. Sealing just drains the buffer so the terminal status entry
     * reaches viewers promptly.
     */
    async seal(environmentId: string): Promise<void> {
        this.logger.debug("Sealing build log stream (flush only - Loki retention handles expiry)", {
            environmentId,
        });
        await this.flush();
    }

    /** Stop the flush timer and drain whatever is still buffered. */
    async close(): Promise<void> {
        clearInterval(this.timer);
        await this.flush();
    }

    private async flush(): Promise<void> {
        if (this.buffer.length === 0) return;
        const lines = this.buffer;
        this.buffer = [];

        // Group buffered lines into one payload stream per label set. Labels
        // are built in a fixed key order in append, so JSON is a stable key.
        const byLabelSet = new Map<string, LokiStreamPayload>();
        for (const entry of lines) {
            const key = JSON.stringify(entry.labels);
            const group = byLabelSet.get(key) ?? { stream: entry.labels, values: [] };
            group.values.push([entry.tsNs, entry.line]);
            byLabelSet.set(key, group);
        }

        try {
            const response = await fetch(`${this.baseUrl}/loki/api/v1/push`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ streams: [...byLabelSet.values()] }),
            });
            if (!response.ok) {
                const body = await response.text();
                this.logger.warn("Loki rejected build log push, dropping batch", {
                    status: response.status,
                    body,
                    dropped: lines.length,
                });
            }
        } catch (err) {
            this.logger.warn("Loki build log push failed, dropping batch", { dropped: lines.length, err });
        }
    }
}
