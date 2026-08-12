import { RouteErrorState } from "components/route-error-state";
import { RoutePendingSkeleton } from "components/route-pending-skeleton";

/**
 * Router options every host must set, shared so a story cannot silently disagree with the app.
 *
 * `defaultPendingComponent` and `defaultErrorComponent` are not just fallbacks - they are what
 * CREATES the per-route boundaries. TanStack only wraps a match in Suspense (and in a catch boundary)
 * when the route has a pending (or error) component; without these, 63 of 70 routes had none, so
 * every wait and every throw escaped to the root Outlet's `<Suspense fallback={null}>` and blanked
 * the whole app, sidebar included.
 *
 * Its own module rather than an export from `main.tsx`, because importing that file would run
 * `createRoot`. Options that are genuinely app-only - Sentry's `defaultOnCatch`, browser scroll
 * restoration - stay at their call site, so the distinction is stated rather than left to whoever
 * next compares the two files.
 */
export const DEFAULT_ROUTER_OPTIONS = {
    defaultPendingMs: 200,
    defaultPendingComponent: RoutePendingSkeleton,
    defaultErrorComponent: RouteErrorState,
} as const;
