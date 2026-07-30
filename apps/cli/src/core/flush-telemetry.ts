import { flushReplay } from "../replay/replay-transport";
import { flushAnalytics } from "./analytics";
import { flushLogs } from "./logs";

/**
 * Drain every telemetry lane - captured events, buffered log records, and any
 * session-replay batch still in flight - before the process exits. Every exit
 * path calls this rather than one flush alone, so a run that ends through a
 * signal, an uncaught error, or a normal return never strands the records that
 * explain what it was doing.
 *
 * Best-effort by design: each lane is bounded internally and none rejects. The
 * replay lane is a no-op unless the run opted into recording.
 */
export async function flushTelemetry(): Promise<void> {
    await Promise.all([flushAnalytics(), flushLogs(), flushReplay()]);
}
