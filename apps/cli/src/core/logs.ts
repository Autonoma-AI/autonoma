import { debugLog } from "./debug";
import { writeDebugRecord } from "./debug-sink";
import { getPostHogConfig } from "./posthog";
import { getRunId } from "./run-id";
import { getSession } from "./session";

// PostHog ingests logs over OTLP/HTTP. We build the JSON envelope by hand rather
// than pulling in @opentelemetry/sdk-node + exporter + api-logs: this is a bundled
// CLI installed through npx on a user's machine, where five extra packages cost
// install time, bundle size, and startup on every run. The payload below is the
// OTLP/JSON logs schema, which is stable, and mirrors how `analytics.ts` posts
// events straight to the capture endpoint.
const LOGS_PATH = "/i/v1/logs";

const SERVICE_NAME = "autonoma-planner";

// Flush whenever either bound trips, so a chatty burst goes out in one request
// and a quiet run still reports within a couple of seconds.
const MAX_BATCH_RECORDS = 50;
const FLUSH_INTERVAL_MS = 2000;

// OpenTelemetry severity numbers (logs data model). PostHog buckets its level
// filter from these, so they have to be the spec values, not our own ordering.
const SEVERITY_NUMBERS = {
    debug: 5,
    info: 9,
    warn: 13,
    error: 17,
} as const;

export type LogLevel = keyof typeof SEVERITY_NUMBERS;

export type LogAttributes = Record<string, string | number | boolean | undefined>;

interface AnyValue {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
}

interface KeyValue {
    key: string;
    value: AnyValue;
}

interface LogRecord {
    timeUnixNano: string;
    severityNumber: number;
    severityText: string;
    body: AnyValue;
    attributes: KeyValue[];
}

// `Date.now()` only resolves to the millisecond, and an agent step emits several
// records inside one - they would land with identical timestamps and the run's
// narrative would come back in arbitrary order. Anchor the wall clock once, then
// advance it with the monotonic high-resolution clock so every record is strictly
// ordered and still corresponds to a real time.
const CLOCK_ORIGIN_MS = Date.now();
const CLOCK_ORIGIN_NS = process.hrtime.bigint();

function nowUnixNano(): bigint {
    return BigInt(CLOCK_ORIGIN_MS) * 1_000_000n + (process.hrtime.bigint() - CLOCK_ORIGIN_NS);
}

const queue: LogRecord[] = [];
const inFlight = new Set<Promise<unknown>>();

let flushTimer: NodeJS.Timeout | undefined;

/**
 * Ship one structured log record describing what the run is doing. Fire-and-forget
 * with the same guarantees as `track`: never throws, never blocks the CLI, and
 * failures are swallowed to a debug breadcrumb.
 *
 * Records carry run/session/generation ids (see `session.ts`) so a support request
 * resolves to one run's ordered narrative. Metadata about the work - step names,
 * tool names, file paths, durations - is in scope; file contents, prompts, and
 * model output are never sent.
 */
export function captureLog(level: LogLevel, message: string, attributes: LogAttributes = {}): void {
    writeDebugRecord(getRunId(), "log", { level, message, ...attributes });

    if (!getPostHogConfig().enabled) return;

    enqueue(buildRecord(level, message, attributes));
}

/**
 * Drain buffered records before exit. Best-effort and bounded by `timeoutMs` so a
 * hung network never holds the process open.
 */
export async function flushLogs(timeoutMs = 1500): Promise<void> {
    flush();
    if (inFlight.size === 0) return;
    await Promise.race([
        Promise.allSettled([...inFlight]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
}

function enqueue(record: LogRecord): void {
    queue.push(record);

    if (queue.length >= MAX_BATCH_RECORDS) {
        flush();
        return;
    }

    // unref so a pending flush never keeps the CLI alive past its work.
    flushTimer ??= setTimeout(flush, FLUSH_INTERVAL_MS).unref();
}

function flush(): void {
    if (flushTimer != null) {
        clearTimeout(flushTimer);
        flushTimer = undefined;
    }
    if (queue.length === 0) return;

    const batch = queue.splice(0, queue.length);
    const { key, host } = getPostHogConfig();

    const promise = fetch(`${host}${LOGS_PATH}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(buildPayload(batch)),
    })
        .then((res) => {
            // Ingestion rejects are invisible otherwise - the CLI would look healthy
            // while every log silently vanished. Surface them under AUTONOMA_DEBUG.
            if (!res.ok) debugLog("Log ingestion rejected the batch", { status: res.status, records: batch.length });
        })
        .catch((err) => {
            debugLog("Log ingestion request failed (ignored)", { err });
        })
        .finally(() => inFlight.delete(promise));

    inFlight.add(promise);
}

function buildRecord(level: LogLevel, message: string, attributes: LogAttributes): LogRecord {
    const session = getSession();

    // `posthogDistinctId` and `sessionId` are PostHog's own linking attributes:
    // the first attaches a log to the person profile, the second groups a run and
    // is what a session replay would join on. The snake_case twins are ours, for
    // filtering in the logs UI alongside the matching event properties.
    const merged: LogAttributes = {
        ...attributes,
        posthogDistinctId: session.distinctId,
        sessionId: session.runId,
        run_id: session.runId,
        generation_id: session.generationId,
        project_slug: session.projectSlug,
        cli_version: session.cliVersion,
        node_version: session.nodeVersion,
        identified: session.identified,
    };

    return {
        timeUnixNano: `${nowUnixNano()}`,
        severityNumber: SEVERITY_NUMBERS[level],
        severityText: level.toUpperCase(),
        body: { stringValue: message },
        attributes: toKeyValues(merged),
    };
}

function buildPayload(records: LogRecord[]) {
    return {
        resourceLogs: [
            {
                resource: { attributes: toKeyValues({ "service.name": SERVICE_NAME }) },
                scopeLogs: [{ scope: { name: SERVICE_NAME }, logRecords: records }],
            },
        ],
    };
}

function toKeyValues(attributes: LogAttributes): KeyValue[] {
    const pairs: KeyValue[] = [];
    for (const [key, value] of Object.entries(attributes)) {
        if (value === undefined) continue;
        pairs.push({ key, value: toAnyValue(value) });
    }
    return pairs;
}

function toAnyValue(value: string | number | boolean): AnyValue {
    if (typeof value === "boolean") return { boolValue: value };
    if (typeof value === "number") {
        // OTLP encodes 64-bit ints as strings; anything fractional is a double.
        return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
    }
    return { stringValue: value };
}
