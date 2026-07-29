import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readEnv } from "../env";
import { debugLog } from "./debug";
import { CLI_VERSION } from "./version";

const AUTONOMA_HOME = join(homedir(), ".autonoma");
const DEVICE_ID_PATH = join(AUTONOMA_HOME, ".device-id");
const DISTINCT_ID_PATH = join(AUTONOMA_HOME, ".distinct-id");

// One id per process, attached to every event and every log record - lets you
// group a run's telemetry, count distinct runs, and dedupe. Stable for the life
// of the CLI invocation.
const RUN_ID = randomUUID();

/**
 * The identifiers every event and log record is indexed by. One bundle so the
 * analytics lane and the log lane can never drift into describing the same run
 * two different ways.
 */
export interface SessionContext {
    /** This process's run. Doubles as the PostHog session id, so a run's logs group together. */
    runId: string;
    /** The PostHog person this run belongs to, or an anonymous per-machine device id. */
    distinctId: string;
    /** True when `distinctId` is a real PostHog person handed over by the app, not the device id. */
    identified: boolean;
    /** The onboarding setup this run is fulfilling - the join back to an Autonoma record. */
    generationId?: string;
    projectSlug?: string;
    cliVersion: string;
    nodeVersion: string;
}

interface SessionOverrides {
    generationId?: string;
    projectSlug?: string;
}

let overrides: SessionOverrides = {};
let cachedIdentity: { distinctId: string; identified: boolean } | undefined;

/**
 * Seed the session with the values only `loadConfig` can resolve (they come from
 * the project/global `.env` files it merges into `process.env`, plus the CLI
 * flags). Called once from the run entry point, before any telemetry fires.
 */
export function initSession(patch: SessionOverrides): void {
    overrides = {
        generationId: patch.generationId ?? overrides.generationId,
        projectSlug: patch.projectSlug ?? overrides.projectSlug,
    };
    debugLog("Session initialized", { runId: RUN_ID, ...overrides });
}

/** The current run's identifiers. Safe to call before `initSession`. */
export function getSession(): SessionContext {
    const identity = resolveIdentity();
    return {
        runId: RUN_ID,
        distinctId: identity.distinctId,
        identified: identity.identified,
        generationId: overrides.generationId ?? readEnv().AUTONOMA_GENERATION_ID,
        projectSlug: overrides.projectSlug,
        cliVersion: CLI_VERSION,
        nodeVersion: process.versions.node,
    };
}

/**
 * To stitch the CLI into the landing -> app -> auth -> CLI funnel, the app passes
 * the user's PostHog distinct_id via AUTONOMA_DISTINCT_ID. When present we use it
 * (and let PostHog build the person profile so the funnel connects). Otherwise we
 * fall back to an anonymous per-machine device id.
 */
function resolveIdentity(): { distinctId: string; identified: boolean } {
    if (cachedIdentity != null) return cachedIdentity;

    const known = readKnownDistinctId();
    cachedIdentity =
        known != null ? { distinctId: known, identified: true } : { distinctId: readDeviceId(), identified: false };
    return cachedIdentity;
}

/**
 * Only the first invocation is launched from the app with AUTONOMA_DISTINCT_ID
 * set; a user re-running the CLI by hand loses it, drops to the anonymous device
 * id, and silently leaves the funnel. So the first run persists the id and later
 * runs read it back.
 */
function readKnownDistinctId(): string | undefined {
    const fromEnv = readEnv().AUTONOMA_DISTINCT_ID?.trim();
    if (fromEnv != null && fromEnv.length > 0) {
        persist(DISTINCT_ID_PATH, fromEnv, "distinct id");
        return fromEnv;
    }

    try {
        const stored = readFileSync(DISTINCT_ID_PATH, "utf-8").trim();
        if (stored.length > 0) return stored;
    } catch (err) {
        debugLog("No persisted distinct id; falling back to the anonymous device id", { err });
    }
    return undefined;
}

function readDeviceId(): string {
    try {
        const stored = readFileSync(DEVICE_ID_PATH, "utf-8").trim();
        if (stored.length > 0) return stored;
    } catch (err) {
        debugLog("No cached device id found; generating a fresh one", { err });
    }

    const generated = randomUUID();
    persist(DEVICE_ID_PATH, generated, "device id");
    return generated;
}

function persist(path: string, value: string, label: string): void {
    try {
        mkdirSync(AUTONOMA_HOME, { recursive: true });
        writeFileSync(path, value, { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
        debugLog(`Could not persist ${label}; using an in-memory value for this run`, { err });
    }
}
