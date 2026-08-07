import { takeMemorySnapshot } from "@autonoma/utils";
import type { Span } from "@sentry/node";

/**
 * Attaches a fresh memory snapshot to `span` as attributes, so it shows up
 * alongside the span's own duration in Sentry's trace view instead of a log
 * line. Attributes are a snapshot, not a timeline: call once per span, at the
 * point in its life whose memory state matters (usually right before the
 * wrapped operation returns) - a second call on the same span overwrites the
 * first. A no-op when tracing has no active span (e.g. `tracesSampleRate: 0`).
 */
export function recordMemorySpanAttributes(span: Span | undefined): void {
    if (span == null) return;
    const memory = takeMemorySnapshot();
    span.setAttribute("memory.rss_mb", memory.rssMb);
    span.setAttribute("memory.heap_used_mb", memory.heapUsedMb);
    span.setAttribute("memory.external_mb", memory.externalMb);
    span.setAttribute("memory.array_buffers_mb", memory.arrayBuffersMb);
    span.setAttribute("memory.cgroup_mb", memory.cgroupMb);
}
