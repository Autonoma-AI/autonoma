import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnv } from "../env";
import { debugLog } from "./debug";
import { CLI_VERSION } from "./version";

const AUTONOMA_HOME = join(homedir(), ".autonoma");
const DEVICE_ID_PATH = join(AUTONOMA_HOME, ".device-id");

// PostHog project (public/ingestion) key. Safe to ship in a client - it can
// only write events, not read. Same project as the landing page + app, so the
// CLI events land in the same funnel. Override with AUTONOMA_POSTHOG_KEY.
const POSTHOG_PUBLIC_KEY = "phc_mUOwUj62r8vyiisFPvXLC3G5RftETIBMnKNSHqTBdka";
const DEFAULT_HOST = "https://us.i.posthog.com";

function resolveKey(): string {
    return (readEnv().AUTONOMA_POSTHOG_KEY ?? POSTHOG_PUBLIC_KEY).trim();
}

function resolveHost(): string {
    return (readEnv().AUTONOMA_POSTHOG_HOST ?? DEFAULT_HOST).replace(/\/+$/, "");
}

// Tracking is ON by default; users opt out with DONT_TRACK=1 (or =true).
function trackingDisabled(): boolean {
    const v = readEnv().DONT_TRACK;
    return v === "1" || v === "true";
}

// To stitch the CLI into the landing → app → auth → CLI funnel, the app/portal
// passes the user's PostHog distinct_id to the CLI via AUTONOMA_DISTINCT_ID.
// When present we use it (and let PostHog build the person profile so the funnel
// connects). Otherwise we fall back to an anonymous per-machine device id and
// suppress person processing so we don't create junk persons.
function getIdentity(): string | undefined {
    const id = readEnv().AUTONOMA_DISTINCT_ID?.trim();
    return id && id.length > 0 ? id : undefined;
}

// One id per process, attached to every event - lets you group a run's events,
// count distinct runs, and dedupe. Stable for the life of the CLI invocation.
const RUN_ID = randomUUID();

/**
 * The current run's id. Printed in failure output as a support reference so a
 * user-reported error maps 1:1 to its `$exception` event(s) in analytics.
 */
export function getRunId(): string {
    return RUN_ID;
}

let cachedDeviceId: string | undefined;

function getDeviceId(): string {
    if (cachedDeviceId) return cachedDeviceId;
    try {
        cachedDeviceId = readFileSync(DEVICE_ID_PATH, "utf-8").trim();
        if (cachedDeviceId) return cachedDeviceId;
    } catch (err) {
        debugLog("No cached device id found; generating a fresh one", { err });
    }
    cachedDeviceId = randomUUID();
    try {
        mkdirSync(AUTONOMA_HOME, { recursive: true });
        writeFileSync(DEVICE_ID_PATH, cachedDeviceId, { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
        debugLog("Could not persist device id; using an in-memory id for this run", { err });
    }
    return cachedDeviceId;
}

let enabled: boolean | undefined;

function isEnabled(): boolean {
    if (enabled === undefined) {
        enabled = !trackingDisabled() && resolveKey().length > 0;
    }
    return enabled;
}

const pending = new Set<Promise<unknown>>();

/**
 * Fire-and-forget anonymous event capture. Never throws and never blocks the
 * CLI - failures are swallowed. No PII or source code is ever sent.
 */
export function track(event: string, properties: Record<string, unknown> = {}): void {
    if (!isEnabled()) return;

    const identity = getIdentity();
    const body = JSON.stringify({
        api_key: resolveKey(),
        event,
        distinct_id: identity ?? getDeviceId(),
        properties: {
            ...properties,
            run_id: RUN_ID,
            // Only build a person profile when we have a real identity from the app,
            // so the CLI joins the existing funnel person instead of creating a new one.
            $process_person_profile: identity != null,
            cli_version: CLI_VERSION,
            // Runtime version - lets us confirm/monitor Node-version-specific
            // failures (e.g. a `util.styleText` crash on Node < 22.13 in old deps).
            node_version: process.versions.node,
        },
    });

    const promise = fetch(`${resolveHost()}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
    })
        .catch((err) => {
            debugLog("Analytics capture request failed (ignored)", { err });
        })
        .finally(() => pending.delete(promise));

    pending.add(promise);
}

/**
 * Capture an exception in PostHog error tracking (`$exception` event).
 * Same fire-and-forget guarantees as `track`. Error messages and stacks may
 * reference CLI-internal file paths, never the user's source code.
 */
export function trackError(error: unknown, properties: Record<string, unknown> = {}, handled = true): void {
    const err = error instanceof Error ? error : new Error(String(error));
    track("$exception", {
        ...properties,
        $exception_list: [
            {
                type: err.name,
                value: err.message,
                mechanism: { handled, synthetic: !(error instanceof Error) },
            },
        ],
        error_stack: err.stack,
    });
}

/** Flush in-flight events before exit. Best-effort, bounded by `timeoutMs`. */
export async function flushAnalytics(timeoutMs = 1500): Promise<void> {
    if (pending.size === 0) return;
    await Promise.race([Promise.allSettled([...pending]), new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
}
