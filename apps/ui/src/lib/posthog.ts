// posthog-js's default build lazily fetches its extension bundles (recorder, surveys, web-vitals,
// conversations) from PostHog's CDN at runtime - even proxied through our own domain (see nginx's
// /rs location), that separate fetch is still a distinct target for ad-blocker heuristics. The
// "no-external" build never attempts that fetch at all - it has no fallback - so every extension
// this app actually uses must be statically imported here instead. Each one self-registers onto
// `window.__PosthogExtensions__` at import time, which the core module checks before deciding
// whether a capability is already available. Anything not imported below will silently never load,
// even if the PostHog project dashboard enables it - it needs a matching import added here.
import "posthog-js/dist/posthog-recorder";
import "posthog-js/dist/surveys";
import "posthog-js/dist/web-vitals";
import "posthog-js/dist/conversations";

// Every call site must import the singleton from here, never from the bare "posthog-js" package -
// that package's default export is a *different* singleton instance that this app never calls
// `.init()` on.
export { default } from "posthog-js/dist/module.no-external";
export * from "posthog-js/dist/module.no-external";
