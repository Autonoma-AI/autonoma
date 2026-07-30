import { readEnv } from "../env";

// PostHog project (public/ingestion) key. Safe to ship in a client - it can
// only write events and logs, not read. Same project as the landing page + app,
// so CLI telemetry lands in the same funnel. Override with AUTONOMA_POSTHOG_KEY.
const POSTHOG_PUBLIC_KEY = "phc_mUOwUj62r8vyiisFPvXLC3G5RftETIBMnKNSHqTBdka";
const DEFAULT_HOST = "https://us.i.posthog.com";

export interface PostHogConfig {
    key: string;
    /** Never carries a trailing slash, so callers can append a path directly. */
    host: string;
    /** False when the user opted out with DONT_TRACK, or no ingestion key is configured. */
    enabled: boolean;
}

/** Last resolved config, keyed by the raw env values it was built from. */
let cached: { signature: string; config: PostHogConfig } | undefined;

/**
 * Transport settings shared by every telemetry lane - the event capture in
 * `analytics.ts`, the log shipping in `logs.ts`, and the session replay in
 * `replay/`. Resolved on demand rather than at import: the CLI populates
 * `process.env` at runtime from the project's `.env` and the global
 * `~/.autonoma/.env`, so an import-time snapshot would miss an override that
 * only lands once `loadConfig` has run.
 *
 * Tracking is ON by default; users opt out with DONT_TRACK=1 (or =true), which
 * disables events, logs and session replay together - one switch, no partial
 * opt-out.
 */
export function getPostHogConfig(): PostHogConfig {
    // readEnv builds and runs a Zod schema over the whole environment, which
    // costs about a millisecond - fine once, but this is called for every log
    // record and every batch, so a run shipping thousands spends seconds of its
    // wall clock revalidating variables that did not change. Memoized against
    // the raw values it reads, so an override landing later still takes effect
    // and on-demand resolution is preserved.
    const signature = [
        process.env.AUTONOMA_POSTHOG_KEY,
        process.env.AUTONOMA_POSTHOG_HOST,
        process.env.DONT_TRACK,
    ].join("\u0000");
    if (cached?.signature === signature) return cached.config;

    const env = readEnv();
    const key = (env.AUTONOMA_POSTHOG_KEY ?? POSTHOG_PUBLIC_KEY).trim();
    const optedOut = env.DONT_TRACK === "1" || env.DONT_TRACK === "true";

    const config: PostHogConfig = {
        key,
        host: (env.AUTONOMA_POSTHOG_HOST ?? DEFAULT_HOST).replace(/\/+$/, ""),
        enabled: !optedOut && key.length > 0,
    };
    cached = { signature, config };
    return config;
}
