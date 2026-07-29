import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { captureLog, flushLogs } from "../../src/core/logs";
import { initSession } from "../../src/core/session";

interface CapturedRequest {
    url: string;
    headers: Record<string, string>;
    body: OtlpPayload;
}

interface OtlpAnyValue {
    stringValue?: string;
    intValue?: string;
    doubleValue?: number;
    boolValue?: boolean;
}

interface OtlpPayload {
    resourceLogs: {
        resource: { attributes: { key: string; value: OtlpAnyValue }[] };
        scopeLogs: {
            scope: { name: string };
            logRecords: {
                timeUnixNano: string;
                severityNumber: number;
                severityText: string;
                body: OtlpAnyValue;
                attributes: { key: string; value: OtlpAnyValue }[];
            }[];
        }[];
    }[];
}

const requests: CapturedRequest[] = [];

// The captured OTLP body is what actually reaches PostHog, so assertions read
// attributes back out of it the same way the ingestion endpoint would.
function attr(
    record: { attributes: { key: string; value: OtlpAnyValue }[] },
    key: string,
): string | number | boolean | undefined {
    const found = record.attributes.find((a) => a.key === key);
    if (found == null) return undefined;
    const { stringValue, intValue, doubleValue, boolValue } = found.value;
    return stringValue ?? intValue ?? doubleValue ?? boolValue;
}

beforeEach(() => {
    requests.length = 0;
    process.env.AUTONOMA_POSTHOG_KEY = "phc_test";
    process.env.AUTONOMA_POSTHOG_HOST = "https://posthog.test";
    delete process.env.DONT_TRACK;
    initSession({ generationId: "gen_123", projectSlug: "acme-web" });

    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string, init: { headers: Record<string, string>; body: string }) => {
            requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
            return { ok: true, status: 200 };
        }),
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AUTONOMA_POSTHOG_KEY;
    delete process.env.AUTONOMA_POSTHOG_HOST;
    delete process.env.DONT_TRACK;
});

// `requests` is only populated after a flush, since records are batched.
function flattened() {
    return requests.flatMap((r) => r.body.resourceLogs[0]?.scopeLogs[0]?.logRecords ?? []);
}

describe("captureLog", () => {
    test("ships the message and level to the OTLP logs endpoint", async () => {
        captureLog("warn", "Step failed: Build a knowledge base");
        await flushLogs();

        expect(requests).toHaveLength(1);
        expect(requests[0]?.url).toBe("https://posthog.test/i/v1/logs");
        expect(requests[0]?.headers.Authorization).toBe("Bearer phc_test");

        const [record] = flattened();
        expect(record?.body.stringValue).toBe("Step failed: Build a knowledge base");
        // OpenTelemetry severity number for WARN - PostHog buckets its level filter from this.
        expect(record?.severityNumber).toBe(13);
        expect(record?.severityText).toBe("WARN");
    });

    test("indexes every record by the run, generation, and person ids", async () => {
        captureLog("info", "Run started");
        await flushLogs();

        const [record] = flattened();
        expect(record).toBeDefined();
        if (record == null) return;

        expect(attr(record, "generation_id")).toBe("gen_123");
        expect(attr(record, "project_slug")).toBe("acme-web");
        // PostHog's own linking attributes: person profile and session grouping.
        expect(attr(record, "posthogDistinctId")).toBeDefined();
        expect(attr(record, "sessionId")).toBe(attr(record, "run_id"));
    });

    test("groups every record in a run under one session id", async () => {
        captureLog("info", "first");
        captureLog("info", "second");
        await flushLogs();

        const sessions = new Set(flattened().map((r) => attr(r, "sessionId")));
        expect(sessions.size).toBe(1);
    });

    test("batches records into a single request", async () => {
        captureLog("info", "one");
        captureLog("info", "two");
        captureLog("info", "three");
        await flushLogs();

        expect(requests).toHaveLength(1);
        expect(flattened()).toHaveLength(3);
    });

    test("sends nothing when the user opted out with DONT_TRACK", async () => {
        process.env.DONT_TRACK = "1";

        captureLog("error", "should not ship");
        await flushLogs();

        expect(requests).toHaveLength(0);
    });

    test("encodes numeric and boolean attributes with their OTLP types", async () => {
        captureLog("info", "Step done", { duration_ms: 1234, ratio: 0.5, non_interactive: true });
        await flushLogs();

        const [record] = flattened();
        expect(record).toBeDefined();
        if (record == null) return;

        expect(record.attributes.find((a) => a.key === "duration_ms")?.value).toEqual({ intValue: "1234" });
        expect(record.attributes.find((a) => a.key === "ratio")?.value).toEqual({ doubleValue: 0.5 });
        expect(record.attributes.find((a) => a.key === "non_interactive")?.value).toEqual({ boolValue: true });
    });

    test("drops undefined attributes rather than sending empty values", async () => {
        initSession({ projectSlug: "acme-web" });
        captureLog("info", "no optional value", { missing: undefined });
        await flushLogs();

        const [record] = flattened();
        expect(record?.attributes.some((a) => a.key === "missing")).toBe(false);
    });

    test("truncates an oversized message instead of shipping it whole", async () => {
        captureLog("info", "x".repeat(5000));
        await flushLogs();

        const body = flattened()[0]?.body.stringValue ?? "";
        expect(body.length).toBeLessThan(5000);
        expect(body.endsWith("...")).toBe(true);
    });

    test("timestamps records so a burst inside one millisecond still orders correctly", async () => {
        captureLog("info", "first");
        captureLog("info", "second");
        captureLog("info", "third");
        await flushLogs();

        const stamps = flattened().map((r) => BigInt(r.timeUnixNano));
        expect(stamps).toHaveLength(3);
        expect(stamps[1]).toBeGreaterThan(stamps[0] ?? 0n);
        expect(stamps[2]).toBeGreaterThan(stamps[1] ?? 0n);
    });

    test("tags the batch with the service name so logs are filterable", async () => {
        captureLog("info", "hello");
        await flushLogs();

        const resourceAttrs = requests[0]?.body.resourceLogs[0]?.resource.attributes ?? [];
        expect(resourceAttrs.find((a) => a.key === "service.name")?.value.stringValue).toBe("autonoma-planner");
    });
});
