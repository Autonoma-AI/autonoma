import { Skeleton } from "@autonoma/blacklight";

/**
 * The router's `defaultPendingComponent`, and the reason every route now has a Suspense boundary at all:
 * TanStack only wraps a match in one when the route has a pending component, so without this a wait
 * escapes to the root Outlet and blanks the whole app, sidebar included.
 *
 * Deliberately layout-agnostic. It renders inside the app shell's padded content well for most routes,
 * but the default also covers the routes outside the shell (`/login`, `/preview-waiting`), so it must not
 * assume a sidebar, a header, or a bounded height. Routes whose shape is worth previewing override it with
 * their own `pendingComponent`.
 */
export function RoutePendingSkeleton() {
  return (
    <div className="flex w-full flex-col gap-4 p-6">
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-4 w-80" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
