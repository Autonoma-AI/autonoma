import { flushAnalytics } from "./analytics";
import { flushLogs } from "./logs";

/**
 * Drain both telemetry lanes - captured events and buffered log records - before
 * the process exits. Every exit path calls this rather than either flush alone,
 * so a run that ends through a signal, an uncaught error, or a normal return
 * never strands the log records that explain what it was doing.
 *
 * Best-effort by design: both lanes are bounded internally and neither rejects.
 */
export async function flushTelemetry(): Promise<void> {
    await Promise.all([flushAnalytics(), flushLogs()]);
}
