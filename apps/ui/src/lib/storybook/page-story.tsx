import { QueryClient, QueryClientProvider, QueryErrorResetBoundary } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { authClient } from "lib/auth";
import { DEFAULT_ROUTER_OPTIONS } from "lib/router-defaults";
import { DEFAULT_QUERY_OPTIONS, trpc } from "lib/trpc";
import { useState } from "react";
import { routeTree } from "../../routeTree.gen";

interface PageStoryProps {
  /** App path to render, e.g. "/app/acme-web/tests". */
  path: string;
}

/**
 * Renders a REAL app route through the real route tree at the given path -
 * loaders, beforeLoad guards, layouts and all. Every piece of data the page
 * needs must be answered by the story's MSW handlers (see `baseHandlers` for
 * the app-shell baseline), so no backend or onboarding is required.
 *
 * Both the query and router defaults come from the app's own, layering only what a story genuinely
 * needs on top. A story that restates them measures request behaviour the app does not have.
 */
export function PageStory({ path }: PageStoryProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // A failed fixture should surface as an error boundary immediately, not three retries later.
        defaultOptions: { queries: { ...DEFAULT_QUERY_OPTIONS, retry: false } },
      }),
  );
  const [router] = useState(() =>
    createRouter({
      ...DEFAULT_ROUTER_OPTIONS,
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
      context: { auth: authClient, queryClient, trpc },
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <QueryErrorResetBoundary>
        <RouterProvider router={router} />
      </QueryErrorResetBoundary>
    </QueryClientProvider>
  );
}
