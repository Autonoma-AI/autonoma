import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, useLocation, useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "hooks/use-is-mobile";
import { Monitor } from "lucide-react";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useAuth } from "../lib/auth";
import type { authClient } from "../lib/auth";
import type { TRPCOptionsProxy } from "../lib/trpc";

const ONBOARDING_PATH = "/onboarding";

/**
 * The onboarding search keys worth breaking the funnel down by: which entry
 * point the user came through, and which fork of the flow they are on.
 */
const FUNNEL_SEARCH_KEYS = ["origin", "step", "configStep", "provider", "manual"] as const;

// Routes that must work on a phone. The blocker exists because the app proper is
// desktop-only, but these are hand-off pages reached from a link someone may well
// have opened on their phone - a preview URL out of a GitHub comment, or the login
// that gates it. Blocking them would strand the visitor on "come back on a
// computer" instead of the app they were trying to reach.
const MOBILE_ALLOWED_PATHS = ["/preview-waiting", "/login"];

export interface RouteContext {
  auth: typeof authClient;
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy;
}

export const Route = createRootRouteWithContext<RouteContext>()({
  component: RootLayout,
});

/** PostHog group type for a customer. Must match the key the backend passes to `analytics.capture`. */
const ORGANIZATION_GROUP = "organization";

function usePosthogIdentify() {
  const { user, isAuthenticated, activeOrganizationId } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;

    posthog.identify(user.id, {
      email: user.email,
      name: user.name,
      organizationId: activeOrganizationId,
    });

    // Every backend event is captured with `groups: { organization }`, so without
    // this the browser's half of a funnel carries no group and any org-aggregated
    // insight silently drops it. That is not hypothetical for onboarding: the
    // machine-driven steps (`surface: signal | system`) have no acting user and
    // are attributed to the org, so the activation funnel has to be org-scoped -
    // and would break at the first client step.
    if (activeOrganizationId != null) {
      posthog.group(ORGANIZATION_GROUP, activeOrganizationId);
    }
  }, [isAuthenticated, user, activeOrganizationId]);
}

function readFunnelProperties(searchStr: string): Record<string, string> {
  const params = new URLSearchParams(searchStr);
  const properties: Record<string, string> = {};
  for (const key of FUNNEL_SEARCH_KEYS) {
    const value = params.get(key);
    if (value != null && value !== "") properties[key] = value;
  }
  return properties;
}

/**
 * The client half of the activation funnel, driven off the route rather than
 * click sites so it sits with the other centralized capture calls.
 *
 * `onboarding.opened` fires once per app session; `onboarding.step_viewed` fires
 * for each step the user lands on. The two exist for different questions than
 * the server's `onboarding.step_changed`, which only counts steps the backend
 * PERSISTED - a step someone opened, could not get through, and abandoned never
 * reaches it, and that is precisely the step worth finding. Comparing viewed
 * against changed for the same step is the drop-off.
 *
 * `enabled` is false on mobile, where the layout renders the blocker instead of
 * onboarding - counting those would inflate the funnel with users who never saw it.
 */
function useOnboardingFunnel(enabled: boolean) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const searchStr = useRouterState({ select: (state) => state.location.searchStr });
  const openedFired = useRef(false);
  // The last step reported, so re-renders and unrelated search changes (an appId
  // landing, a focus deep-link) don't each count as another view of it.
  const lastStepViewed = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!enabled || !pathname.startsWith(ONBOARDING_PATH)) return;

    const properties = readFunnelProperties(searchStr);
    if (!openedFired.current) {
      openedFired.current = true;
      posthog.capture("onboarding.opened", properties);
    }

    // Absent on entry and on resume, where the step is resolved from the
    // persisted backend state rather than the URL. The next in-flow navigation
    // sets it, and `onboarding.opened` already counts the entry.
    const step = properties.step;
    if (step == null || step === lastStepViewed.current) return;
    lastStepViewed.current = step;
    posthog.capture("onboarding.step_viewed", properties);
  }, [enabled, pathname, searchStr]);
}

function MobileBlocker() {
  return (
    <div className="blacklight flex min-h-dvh flex-col items-center justify-center gap-6 bg-surface-void px-8 text-center">
      <div className="flex size-16 items-center justify-center rounded-2xl bg-surface-secondary">
        <Monitor className="size-8 text-text-secondary" />
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-text-primary">Not available on mobile yet</h1>
        <p className="max-w-sm text-base text-text-tertiary">
          Autonoma is designed for desktop. Please come back on a computer to get started.
        </p>
      </div>
    </div>
  );
}

function RootLayout() {
  const { session } = useAuth();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();

  usePosthogIdentify();
  useOnboardingFunnel(!isMobile);

  const isMobileAllowed = MOBILE_ALLOWED_PATHS.some((path) => pathname.startsWith(path));

  if (isMobile && !isMobileAllowed) {
    return <MobileBlocker />;
  }

  if (session.isPending) {
    return (
      <div className="blacklight flex min-h-screen items-center justify-center bg-surface-void">
        <span className="text-text-tertiary">Loading…</span>
      </div>
    );
  }

  return <Outlet />;
}
