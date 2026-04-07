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

if (isPostHogEnabled) {
  const params = new URLSearchParams(window.location.search);
  const crossDomainId = params.get("ph_id");

  posthog.init(posthogKey, {
    api_host: "/ingest",
    ui_host: "https://us.posthog.com",
    session_recording: {
      recordCrossOriginIframes: true,
    },
    bootstrap: crossDomainId != null ? { distinctID: crossDomainId } : undefined,
  });

  if (crossDomainId != null) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("ph_id");
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
