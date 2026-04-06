import type { QueryClient } from "@tanstack/react-query";
import { Outlet, createRootRouteWithContext } from "@tanstack/react-router";
import { useIsMobile } from "hooks/use-is-mobile";
import { Monitor } from "lucide-react";
import posthog from "posthog-js";
import { useEffect } from "react";
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
    if (isAuthenticated) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
        organizationId: activeOrganizationId,
      });
    }
  }, [isAuthenticated, user, activeOrganizationId]);
}

function MobileBlocker() {
  return (
    <div className="blacklight-dark flex min-h-dvh flex-col items-center justify-center gap-6 bg-surface-void px-8 text-center">
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

  usePosthogIdentify();

  if (isMobile) {
    return <MobileBlocker />;
  }

  if (session.isPending) {
    return (
      <div className="blacklight-dark flex min-h-screen items-center justify-center bg-surface-void">
        <span className="text-text-tertiary">Loading…</span>
      </div>
    );
  }

  return <Outlet />;
}
