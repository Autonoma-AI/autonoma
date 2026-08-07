import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readEnv } from "../env";

/**
 * A durable, local, machine-readable record of a run.
 *
 * The dashboard's log is wiped when Ink unmounts and stderr breadcrumbs scroll
 * away, so when a run ends badly there is often nothing left to read - which is
 * exactly when someone needs it. This writes every breadcrumb, log record and
 * analytics event to a file as JSONL, independent of the TUI and independent of
 * whether telemetry is enabled at all (`DONT_TRACK` runs still get a local file).
 *
 * Off unless asked for: set `AUTONOMA_DEBUG=1` for the default path under
 * `~/.autonoma/debug/`, or `AUTONOMA_DEBUG_FILE=/path/to/file.jsonl` to choose
 * one. Never throws - a diagnostic that can break the run is worse than none.
 */
const DEBUG_DIR = join(homedir(), ".autonoma", "debug");

let resolved: string | undefined | null = null;
let failed = false;

/** The file this run is writing to, or undefined when debug capture is off. */
export function debugFilePath(runId: string): string | undefined {
    if (resolved !== null) return resolved;
    const env = readEnv();
    const explicit = env.AUTONOMA_DEBUG_FILE?.trim();
    if (explicit != null && explicit !== "") {
        resolved = explicit;
        return resolved;
    }
    const flag = env.AUTONOMA_DEBUG;
    resolved = flag === "1" || flag === "true" ? join(DEBUG_DIR, `${runId}.jsonl`) : undefined;
    return resolved;
}

export type DebugRecordKind = "breadcrumb" | "log" | "event" | "context";

/**
 * Append one record. `data` is whatever the caller already had - this adds only
 * a timestamp and a kind, so the file stays a faithful transcript rather than a
 * second, differently-shaped telemetry format to keep in sync.
 */
export function writeDebugRecord(runId: string, kind: DebugRecordKind, data: Record<string, unknown>): void {
    if (failed) return;
    try {
        // Inside the try: this reads the env, and the caller is often a catch
        // block. A breadcrumb that throws would mask the error it was recording.
        const path = debugFilePath(runId);
        if (path == null) return;
        mkdirSync(dirname(path), { recursive: true });
        // Same 0600 as the id files in session.ts: this transcript carries the
        // device and distinct ids, so it must not be world-readable either.
        appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), kind, ...data }, replaceErrors)}\n`, {
            mode: 0o600,
        });
    } catch (err) {
        // One warning, then stay quiet: a full disk or an unwritable path must not
        // turn every subsequent breadcrumb into another failed write.
        failed = true;
        process.stderr.write(`[autonoma:debug] debug capture disabled after a write error: ${String(err)}\n`);
    }
}

/** Errors serialize to `{}` through JSON.stringify; keep what makes them useful. */
export function replaceErrors(_key: string, value: unknown): unknown {
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    return value;
}
