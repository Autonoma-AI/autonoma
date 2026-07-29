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

/**
 * Transport settings shared by both telemetry lanes - the event capture in
 * `analytics.ts` and the log shipping in `logs.ts`. Resolved on demand rather
 * than at import: the CLI populates `process.env` at runtime from the project's
 * `.env` and the global `~/.autonoma/.env`, so an import-time snapshot would
 * miss an override that only lands once `loadConfig` has run.
 *
 * Tracking is ON by default; users opt out with DONT_TRACK=1 (or =true), which
 * disables events and logs together - one switch, no partial opt-out.
 */
export function getPostHogConfig(): PostHogConfig {
    const env = readEnv();
    const key = (env.AUTONOMA_POSTHOG_KEY ?? POSTHOG_PUBLIC_KEY).trim();
    const optedOut = env.DONT_TRACK === "1" || env.DONT_TRACK === "true";

    return {
        key,
        host: (env.AUTONOMA_POSTHOG_HOST ?? DEFAULT_HOST).replace(/\/+$/, ""),
        enabled: !optedOut && key.length > 0,
    };
}
