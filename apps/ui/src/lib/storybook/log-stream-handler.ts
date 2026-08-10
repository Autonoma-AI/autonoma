import { http, HttpResponse } from "msw";

/** One frame of the previewkit log stream, as the server would emit it. */
export interface LogStreamEvent {
    /** SSE event name: `phase`, `log`, `status`, or the terminal `done`. */
    event: string;
    /** The `data:` payload. Objects are JSON-encoded; `done` carries a bare string. */
    data?: object | string;
    /** Wall-clock time of the frame, rendered into the Loki-style nanosecond id the viewer parses. */
    at: Date;
}

/**
 * Answers the previewkit log-stream SSE endpoint with canned frames, so a story can
 * show a real terminal instead of `stream unavailable (HTTP 404)`.
 *
 * The stream is CLOSED once the frames are written. The screenshot script waits for
 * network idle, which a stream left open would block forever - so a story that keeps
 * it open never produces an image.
 */
export function logStreamHandler(frames: { build: LogStreamEvent[]; app: LogStreamEvent[] }) {
    return http.get("*/v1/previewkit/environments/:owner/:repo/:pr/logs/stream", ({ request }) => {
        const source = new URL(request.url).searchParams.get("source") === "app" ? "app" : "build";
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(encoder.encode(sseFrames(frames[source])));
                controller.close();
            },
        });
        return new HttpResponse(body, { headers: { "Content-Type": "text/event-stream" } });
    });
}

/** Serialize events into the stream's wire format: one `id`/`event`/`data` frame each. */
function sseFrames(events: LogStreamEvent[]): string {
    return events
        .map((entry) => {
            const data = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {});
            return `id: ${entry.at.getTime()}000000\nevent: ${entry.event}\ndata: ${data}\n\n`;
        })
        .join("");
}
