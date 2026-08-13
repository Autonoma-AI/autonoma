import { cn, Skeleton } from "@autonoma/blacklight";
import { RoutePendingSkeleton } from "components/route-pending-skeleton";
import { APP_SHELL_GUTTER } from "./app-shell-gutter";
import { EarlyVersionPill } from "./early-version-pill";

/**
 * The shell's own loading state, for the one wait no other skeleton can cover: while
 * `_app-shell/route.tsx`'s gate resolves the session, organization and application list, the real bar cannot
 * render because it has no application to name and no sections to offer. Without this the gate blanks the
 * entire viewport.
 *
 * It mirrors the bar's height, border and gutter exactly, so the real one replaces it in place instead of
 * shifting the page under the reader. The pieces that need no data - the wordmark and its pill - are drawn
 * for real rather than skeletoned, because a grey bar standing in for a logo we already have is a worse
 * likeness than the logo.
 */
export function AppShellSkeleton() {
  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-surface-void">
      <header className="relative z-20 flex h-14 shrink-0 items-center border-b border-border-dim bg-surface-void">
        <div className={cn("flex h-full w-full items-center gap-3", APP_SHELL_GUTTER.bar, APP_SHELL_GUTTER.container)}>
          <div className="flex shrink-0 items-center gap-2">
            <img src="/wordmark.svg" alt="Autonoma" className="h-5 w-auto" />
            <EarlyVersionPill />
          </div>

          <Skeleton className="h-7 w-56 shrink-0" />

          <span className="flex-1" />

          <Skeleton className="h-7 w-64 shrink-0" />
          <Skeleton className="size-7 shrink-0" />
        </div>
      </header>

      <main className="relative z-10 flex-1 overflow-y-auto">
        <RoutePendingSkeleton />
      </main>
    </div>
  );
}
