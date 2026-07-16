import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryHistory, createRouter } from "@tanstack/react-router";
import { authClient } from "lib/auth";
import { trpc } from "lib/trpc";
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
 */
export function PageStory({ path }: PageStoryProps) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  const [router] = useState(() =>
    createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [path] }),
      defaultPendingMs: 200,
      context: { auth: authClient, queryClient, trpc },
    }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
