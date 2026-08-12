import { Skeleton } from "@autonoma/blacklight";
import { RoutePendingSkeleton } from "components/route-pending-skeleton";
import { useSidebarCollapsed } from "./sidebar";
import { sidebarGridTemplate } from "./sidebar-grid";

const NAV_ROWS = ["nav-1", "nav-2", "nav-3", "nav-4"];

/**
 * The shell's own loading state, for the one wait no other skeleton can cover: while
 * `_app-shell/route.tsx`'s gate resolves the session, org and application list, the real `Sidebar` cannot
 * render because it has no nav items yet. Without this the gate blanks the entire viewport.
 *
 * Mirrors `AppShellLayout`'s grid through the shared `sidebarGridTemplate`, so the real sidebar replaces
 * this one in place rather than shifting the page.
 */
export function AppShellSkeleton() {
  const [collapsed] = useSidebarCollapsed();

  return (
    <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: sidebarGridTemplate(collapsed) }}>
      <div className="flex flex-col gap-3 border-r border-border-dim bg-surface-base p-3">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-12 w-full" />
        <div className="flex flex-col gap-2 pt-3">
          {NAV_ROWS.map((id) => (
            <Skeleton key={id} className="h-7 w-full" />
          ))}
        </div>
        <Skeleton className="mt-auto h-10 w-full" />
      </div>

      <main className="flex flex-col overflow-hidden bg-surface-void">
        <RoutePendingSkeleton />
      </main>
    </div>
  );
}
