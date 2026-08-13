import "@autonoma/blacklight/styles.css";
import * as Sentry from "@sentry/react";
import { QueryClientProvider, QueryErrorResetBoundary } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import { isTRPCClientError } from "@trpc/client";
import posthog from "lib/posthog";
import { DEFAULT_ROUTER_OPTIONS } from "lib/router-defaults";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { env } from "./env";
import { authClient } from "./lib/auth";
import { evictRetiredStorageKeys } from "./lib/storage-migrations";
import { queryClient, trpc } from "./lib/trpc";
import { routeTree } from "./routeTree.gen";

const posthogKey = env.VITE_POSTHOG_KEY;
const isPostHogEnabled = !import.meta.env.DEV && posthogKey != null;

const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 86_400;

function writeAttributionCookie(name: string, value: string) {
  const domain = env.VITE_INTERNAL_DOMAIN;
  const isProduction = !import.meta.env.DEV;
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Domain=.${domain}`,
    "Path=/",
    `Max-Age=${ATTRIBUTION_COOKIE_MAX_AGE_SECONDS}`,
    "SameSite=Lax",
  ];
  if (isProduction) attributes.push("Secure");
  document.cookie = attributes.join("; ");
}

function loadPostHogConversationsAfterPageLoad() {
  const loadConversations = () => posthog.conversations.loadIfEnabled();

  if (document.readyState === "complete") {
    loadConversations();
    return;
  }

  window.addEventListener("load", loadConversations, { once: true });
}

if (isPostHogEnabled) {
  const params = new URLSearchParams(window.location.search);
  const crossDomainId = params.get("ph_id");
  const referringBlog = params.get("referring_blog");
  const hypothesis = params.get("hypothesis");

  if (referringBlog != null) writeAttributionCookie("autonoma_referring_blog", referringBlog);
  if (hypothesis != null) writeAttributionCookie("autonoma_hypothesis", hypothesis);

  posthog.init(posthogKey, {
    api_host: "/rs",
    // Split from api_host so a filter-list hit on one proxy path doesn't take down
    // the other - ad blockers target well-known PostHog proxy path names.
    flags_api_host: "/flags",
    ui_host: "https://us.posthog.com",
    // This is a client-routed SPA, so the default only ever emits the $pageview
    // for the initial document load - every in-app navigation went untracked and
    // all pathname-based metrics undercounted. "history_change" also captures
    // pushState/replaceState navigations.
    capture_pageview: "history_change",
    session_recording: {
      recordCrossOriginIframes: true,
    },
    bootstrap: crossDomainId != null ? { distinctID: crossDomainId } : undefined,
  });
  loadPostHogConversationsAfterPageLoad();

  const hasAttributionParams = crossDomainId != null || referringBlog != null || hypothesis != null;
  if (hasAttributionParams) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("ph_id");
    cleanUrl.searchParams.delete("referring_blog");
    cleanUrl.searchParams.delete("hypothesis");
    window.history.replaceState({}, "", cleanUrl.toString());
  }
}

if (env.VITE_SENTRY_DSN != null) {
  Sentry.init({
    dsn: env.VITE_SENTRY_DSN,
    integrations: isPostHogEnabled ? [posthog.sentryIntegration()] : [],
  });
}

/**
 * Reports what the query cache cannot. `lib/trpc.ts`'s `queryCache.onError` already captures every failed
 * query, and a loader that awaits one throws the same error onward - so capturing indiscriminately here
 * would double-report the common case. What is genuinely unreported is everything else: a render-time
 * throw, or a `beforeLoad`/loader failure that was not a tRPC call.
 */
function reportUncaughtRouteError(error: Error) {
  if (isTRPCClientError(error)) return;
  Sentry.captureException(error);
}

// `DEFAULT_ROUTER_OPTIONS` carries the per-route boundaries, shared with `lib/storybook/page-story.tsx`
// so a story cannot drift from the app. Error reporting and scroll restoration are app-only.
const router = createRouter({
  ...DEFAULT_ROUTER_OPTIONS,
  routeTree,
  defaultOnCatch: reportUncaughtRouteError,
  scrollRestoration: true,
  context: { auth: authClient, queryClient, trpc },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

evictRetiredStorageKeys();

const rootElement = document.getElementById("root");
if (rootElement == null) throw new Error("Root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {/* Scopes the reset `RouteErrorState` calls: without a provider react-query falls back to a
          module-level singleton, so one route's retry would clear every errored query in the app. */}
      <QueryErrorResetBoundary>
        <RouterProvider router={router} />
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  </StrictMode>,
);
