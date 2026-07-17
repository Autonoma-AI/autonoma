import "@autonoma/blacklight/styles.css";
import * as Sentry from "@sentry/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createRouter } from "@tanstack/react-router";
import posthog from "posthog-js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { env } from "./env";
import { authClient } from "./lib/auth";
import { queryClient, trpc } from "./lib/trpc";
import { routeTree } from "./routeTree.gen";

const posthogKey = env.VITE_POSTHOG_KEY;
const isPostHogEnabled = !import.meta.env.DEV && posthogKey != null;

const ATTRIBUTION_COOKIE_MAX_AGE_SECONDS = 86_400;
const POSTHOG_CONVERSATIONS_SCRIPT_PATH = "/static/conversations.js";

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

function preparePostHogExternalDependencyScript(script: HTMLScriptElement) {
  const isConversationsScript = script.src.includes(POSTHOG_CONVERSATIONS_SCRIPT_PATH);
  const shouldDeferConversations = isConversationsScript && document.readyState !== "complete";
  if (shouldDeferConversations) return null;

  return script;
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
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    session_recording: {
      recordCrossOriginIframes: true,
    },
    prepare_external_dependency_script: preparePostHogExternalDependencyScript,
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

const router = createRouter({
  routeTree,
  defaultPendingMs: 200,
  scrollRestoration: true,
  context: { auth: authClient, queryClient, trpc },
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("root");
if (rootElement == null) throw new Error("Root element not found");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
