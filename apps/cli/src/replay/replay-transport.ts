import { debugLog } from "../core/debug";
import type { ReplayEvent } from "./types";

/**
 * posthog-js splits its own batches at ~943KB; stay under that so a batch is
 * never rejected for size.
 */
const MAX_BATCH_BYTES = 800_000;

/**
 * Ceiling on what one run may upload. A pathological run (constant full-screen
 * churn for hours) would otherwise stream unbounded data; past this the
 * recorder stops rather than keep paying.
 */
const MAX_SESSION_BYTES = 25_000_000;

export interface ReplayTransportConfig {
    apiKey: string;
    host: string;
    sessionId: string;
    windowId: string;
    distinctId: string;
}

const pending = new Set<Promise<unknown>>();

/**
 * Drain in-flight replay uploads before exit. The third lane of
 * `flushTelemetry`, alongside events and logs. Best-effort, bounded.
 */
export async function flushReplay(timeoutMs = 1500): Promise<void> {
    if (pending.size === 0) return;
    await Promise.race([
        Promise.allSettled([...pending]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
}

/**
 * Batches rrweb events and ships them to PostHog's replay capture endpoint.
 *
 * Uploads are fire-and-forget for the same reason analytics is: a recording is
 * never worth blocking or failing a run over.
 */
export class ReplayTransport {
    private buffer: ReplayEvent[] = [];
    private bufferBytes = 0;
    private sessionBytes = 0;
    private exhausted = false;

    constructor(private readonly config: ReplayTransportConfig) {}

    /** True once the session cap is hit and further events are being dropped. */
    public get isExhausted(): boolean {
        return this.exhausted;
    }

    public add(events: ReplayEvent[]): void {
        if (this.exhausted || events.length === 0) return;

        for (const event of events) {
            this.buffer.push(event);
            this.bufferBytes += JSON.stringify(event).length;
        }
        if (this.bufferBytes >= MAX_BATCH_BYTES) this.send();
    }

    public flush(): void {
        this.send();
    }

    private send(): void {
        if (this.buffer.length === 0) return;

        const events = this.buffer;
        const bytes = this.bufferBytes;
        this.buffer = [];
        this.bufferBytes = 0;

        this.sessionBytes += bytes;
        if (this.sessionBytes > MAX_SESSION_BYTES) {
            this.exhausted = true;
            debugLog("Session replay cap reached; stopping capture", {
                sessionBytes: this.sessionBytes,
                cap: MAX_SESSION_BYTES,
            });
            return;
        }

        const body = JSON.stringify([
            {
                api_key: this.config.apiKey,
                event: "$snapshot",
                distinct_id: this.config.distinctId,
                timestamp: new Date().toISOString(),
                properties: {
                    $session_id: this.config.sessionId,
                    $window_id: this.config.windowId,
                    $snapshot_data: events,
                    $snapshot_bytes: bytes,
                    // The player treats a recording as web; the synthesized DOM is
                    // a real DOM as far as it is concerned.
                    $lib: "web",
                    $lib_version: "1.0.0",
                },
            },
        ]);

        const promise = fetch(`${this.config.host}/s/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
        })
            .catch((err) => {
                debugLog("Session replay upload failed (ignored)", { err });
            })
            .finally(() => pending.delete(promise));

        pending.add(promise);
    }
}
