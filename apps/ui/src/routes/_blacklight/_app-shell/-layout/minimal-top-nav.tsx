import { cn } from "@autonoma/blacklight";
import { Link, useRouteContext } from "@tanstack/react-router";
import { AccountMenu } from "./account-menu";
import { APP_SHELL_GUTTER } from "./app-shell-gutter";
import { EarlyVersionPill } from "./early-version-pill";
import { OrgSwitcher } from "./org-switcher";

/**
 * The bar for everything that is not about one application: organization settings, the app picker, the
 * finish-setup flow.
 *
 * What is missing is the point. These routes carry no `$appSlug`, so the application switcher and the sections
 * have nothing to name and are simply not there - and the gap where they would be is what says that what you do
 * here applies to every application rather than to the one you came from.
 *
 * The organization switcher is the exception, and it has to be: these routes are exactly where someone in more
 * than one organization ends up with nothing else to reach for. It sits beside the wordmark rather than out at
 * the right, because with no application beside it there is no pair for it to belong to.
 *
 * The wordmark stays, because it is the only route back to the application picker from here: the account menu's
 * "Back to apps" only ever renders for admins on admin pages. Same height and same account menu as the
 * application bar, so the two read as one chrome with a piece taken out rather than as two different products.
 */
export function MinimalTopNav({ onFeedback }: { onFeedback: () => void }) {
  const activeOrganization = useRouteContext({
    from: "/_blacklight/_app-shell",
    select: (ctx) => ctx.activeOrganization,
  });

  return (
    // Opaque for the same reason the application bar is - see `top-nav-bar.tsx`.
    <header className="relative z-20 flex h-14 shrink-0 items-center border-b border-border-dim bg-surface-void">
      <div
        className={cn(
          "flex h-full w-full items-center justify-between",
          APP_SHELL_GUTTER.bar,
          APP_SHELL_GUTTER.container,
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <Link to="/" aria-label="All applications" className="shrink-0">
            <img src="/wordmark.svg" alt="Autonoma" className="h-5 w-auto" />
          </Link>
          <EarlyVersionPill />
          <span className="flex h-7 min-w-0 items-center overflow-hidden border border-border-dim bg-surface-base pl-2">
            <span className="block size-2 shrink-0 rounded-sm bg-primary" />
            <OrgSwitcher activeOrganizationName={activeOrganization.name} />
          </span>
        </div>
        <AccountMenu onFeedback={onFeedback} />
      </div>
    </header>
  );
}
