import { cn } from "@autonoma/blacklight";
import { Link, useLocation } from "@tanstack/react-router";
import type { AppNavItem } from "./use-app-nav";

/**
 * The global switch: the destinations a reader moves between inside one application.
 *
 * The active tab is marked with an accent edge, which is the one treatment that is unmistakably not the
 * underline a tab bar inside a page uses. Both share the type scale and the text tones, so they read as one
 * system; the edge is what says this move changes the whole page rather than a panel of it. It is also the
 * marker carried over from the rail, so it is the one people already know.
 *
 * They are given more room than a dense control would need - they are the thing the bar is for. Whether the set
 * is enclosed, and where in the row it sits, are decisions about the bar rather than about the list, so they live
 * in `TopNavBar`.
 */
export function TopNavSections({
  sections,
  activePath,
}: {
  sections: AppNavItem[];
  /** Overrides where the reader is. Only a story passes this, to show a state its router is not in. */
  activePath?: string;
}) {
  const { pathname } = useLocation();
  const current = activePath ?? pathname;

  return (
    // `shrink-0`, because a flex item is allowed to shrink below its content and these must not. With `min-w-0`
    // the strip compressed while the links kept their width, so at 768-880px the second tab was painted over by
    // the right-hand cluster: a destination you could neither see nor click, with nothing to say it was there.
    // Navigation is the last thing in the bar that may yield - the application name truncates instead.
    <nav aria-label="Sections" className="flex shrink-0 items-center">
      {sections.map(({ icon: ItemIcon, label, href, exact }) => {
        const active = isSectionActive(current, href, exact);
        return (
          <Link
            key={label}
            to={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex items-center gap-2 whitespace-nowrap border-l-2 px-5 py-2 text-sm font-medium transition-colors",
              active
                ? "border-primary bg-surface-raised/40 text-text-primary"
                : "border-transparent text-text-secondary hover:bg-surface-raised/40 hover:text-text-primary",
            )}
          >
            <ItemIcon size={16} weight={active ? "fill" : "regular"} className="shrink-0" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function isSectionActive(pathname: string, href: string, exact?: boolean): boolean {
  if (exact === true) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}
