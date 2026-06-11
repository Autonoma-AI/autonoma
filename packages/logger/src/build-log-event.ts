import { z } from "zod";

/**
 * One event in a preview environment's log relay - the shared shape between
 * the write side (`BuildLogSink`: previewkit's build pipeline) and the read
 * side (`LogStore`: the apps/api SSE relay, mirrored by the browser viewer).
 *
 * IMPORTANT: this is customer-facing data (build output and app stdout/stderr
 * may echo secrets) - it must never flow into the Sentry/console telemetry
 * pipe in this same package. Keep the two planes distinct.
 */
export const BuildLogEventSchema = z.object({
    kind: z.enum(["log", "phase", "status"]),
    /** The app this line belongs to (build output is per-app); absent for phase/status. */
    app: z.string().optional(),
    /** stdout | stderr for runtime app-log lines; absent for build output. */
    stream: z.enum(["stdout", "stderr"]).optional(),
    message: z.string(),
});

export type BuildLogEvent = z.infer<typeof BuildLogEventSchema>;

export interface BuildLogEntry {
    /** Loki entry timestamp in nanoseconds. Doubles as the SSE event id (`Last-Event-ID` resume cursor). */
    id: string;
    event: BuildLogEvent;
}
