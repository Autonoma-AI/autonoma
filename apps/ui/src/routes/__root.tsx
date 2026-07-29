import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext, useLocation, useRouterState } from "@tanstack/react-router";
import { useIsMobile } from "hooks/use-is-mobile";
import { Monitor } from "lucide-react";
import posthog from "posthog-js";
import { useEffect, useRef } from "react";
import { useAuth } from "../lib/auth";
import type { authClient } from "../lib/auth";
import type { TRPCOptionsProxy } from "../lib/trpc";

export interface RouteContext {
  auth: typeof authClient;
  queryClient: QueryClient;
  trpc: TRPCOptionsProxy;
}

export const Route = createRootRouteWithContext<RouteContext>()({
  component: RootLayout,
});

function usePosthogIdentify() {
  const { user, isAuthenticated, activeOrganizationId } = useAuth();

  useEffect(() => {
    if (!isAuthenticated) return;

    posthog.identify(user.id, {
      email: user.email,
      name: user.name,
      organizationId: activeOrganizationId,
    });
  }, [isAuthenticated, user, activeOrganizationId]);
}

/**
 * Captures the activation funnel's entry step, once per app session. Driven off the
 * route rather than a click site so it sits with the other centralized capture
 * calls. `enabled` is false on mobile, where the layout renders the blocker instead
 * of onboarding - counting those would inflate the step with users who never saw it.
 */
function useOnboardingOpened(enabled: boolean) {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const fired = useRef(false);

  useEffect(() => {
    if (!enabled || fired.current || !pathname.startsWith("/onboarding")) return;
    fired.current = true;
    posthog.capture("onboarding.opened");
  }, [enabled, pathname]);
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

// Routes that must work on a phone. The blocker exists because the app proper is
// desktop-only, but these are hand-off pages reached from a link someone may well
// have opened on their phone - a preview URL out of a GitHub comment, or the login
// that gates it. Blocking them would strand the visitor on "come back on a
// computer" instead of the app they were trying to reach.
const MOBILE_ALLOWED_PATHS = ["/preview-waiting", "/login"];

function RootLayout() {
  const { session } = useAuth();
  const isMobile = useIsMobile();
  const { pathname } = useLocation();

  usePosthogIdentify();
  useOnboardingOpened(!isMobile);

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
