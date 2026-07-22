import { ToastProvider } from "@autonoma/blacklight";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  RouterContextProvider,
  createMemoryHistory,
  createRootRouteWithContext,
  createRouter,
} from "@tanstack/react-router";
import { authClient } from "lib/auth";
import { toastManager } from "lib/toast-manager";
import { trpc } from "lib/trpc";
import type { ReactNode } from "react";
import { useState } from "react";
import type { RouteContext } from "routes/__root";

interface StoryShellProps {
  children: ReactNode;
}

/**
 * Wraps a component story in the app's runtime shell: theme, toasts, a fresh
 * QueryClient (so fixture data never bleeds between stories), and a memory
 * router context so components using Link / useNavigate render without the
 * real route tree. Full pages should use PageStory instead.
 */
export function StoryShell({ children }: StoryShellProps) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [router] = useState(() => createShellRouter(queryClient));

  return (
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        <ToastProvider toastManager={toastManager} timeout={2500} limit={3}>
          <div className="blacklight min-h-dvh bg-surface-void text-text-primary">{children}</div>
        </ToastProvider>
      </RouterContextProvider>
    </QueryClientProvider>
  );
}

function createShellRouter(queryClient: QueryClient) {
  const rootRoute = createRootRouteWithContext<RouteContext>()({});
  return createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: ["/"] }),
    context: { auth: authClient, queryClient, trpc },
  });
}
