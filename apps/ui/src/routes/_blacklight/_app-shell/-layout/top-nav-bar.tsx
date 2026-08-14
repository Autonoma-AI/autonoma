import { Separator, cn } from "@autonoma/blacklight";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { APP_SHELL_GUTTER } from "./app-shell-gutter";
import { EarlyVersionPill } from "./early-version-pill";
import { TopNavSections } from "./top-nav-sections";
import type { AppNavItem } from "./use-app-nav";

interface TopNavBarProps {
  sections: AppNavItem[];
  /** Which organization you are acting as. Absent only in the stories that render the bar from literals. */
  orgSwitcher?: ReactNode;
  /** Which application you are in. Absent when the chrome is not scoped to one. */
  appSwitcher?: ReactNode;
  upgrade?: ReactNode;
  account: ReactNode;
  /** Overrides where the reader is. Only a story passes this. */
  activePath?: string;
}

/**
 * The application chrome, in three parts: the brand and where you can go on the left, and everything scoped to
 * this application or to you on the right.
 *
 * **The right-hand end is grouped by what a thing is about, not by what it happens to be.** The switcher says
 * which application you are in, and the account menu already holds settings, billing and sign-out, so "you"
 * needs nothing more than its trigger. That replaces a row of five items from four different scopes with two
 * objects.
 *
 * Suite health used to sit beside the switcher and no longer does. It is a fact about one application, which
 * the application's own page is a better place to state than chrome that follows you onto every screen - and
 * on a page it has room for the rank and the run counts that only a hover could reach up here.
 *
 * **The tabs are left-aligned, and that is load-bearing rather than taste.** They were centred with `flex-1` for a
 * draft, which meant they moved about 110px when the calls to action appeared - so a navigation control shifted
 * with your billing and onboarding state. Aligning them left pins them to a fixed offset, so they hold still
 * whatever appears to their right, and Upgrade gets to stay a filled call to action in the bar instead of being
 * moved out to hold them steady.
 *
 * The rule between the wordmark and the tabs is doing what an enclosure did in an earlier draft, at a fraction of
 * the weight: it says the mark is not one of the tabs, and nothing else. The enclosure was defending the tabs from
 * a crowded left edge that no longer exists now that the switcher has moved right.
 *
 * Data-bound pieces arrive as slots rather than being read here, so this renders from literals in a story - which
 * is how the layout gets argued about without a backend.
 */
export function TopNavBar({ sections, orgSwitcher, appSwitcher, upgrade, account, activePath }: TopNavBarProps) {
  const hasScope = orgSwitcher != null || appSwitcher != null;

  return (
    // The border spans the viewport - it is chrome - while the row inside it shares the page's gutter, so the
    // wordmark and the page heading below it start on the same edge.
    //
    // Opaque, and deliberately so. A translucent bar with `backdrop-blur` makes the bar its own backdrop root,
    // so when a dialog lays its own `backdrop-blur` over the page the bar composites through two of them and the
    // body through one - the bar visibly blurs harder than everything beneath it. Nothing is lost by going
    // opaque: `main` is the scroll container and this sits above it as a flex sibling, so content never passes
    // under the bar and the translucency only ever revealed the static grid background.
    <header className="relative z-20 flex h-14 shrink-0 items-center border-b border-border-dim bg-surface-void">
      <div className={cn("flex h-full w-full items-center gap-3", APP_SHELL_GUTTER.bar, APP_SHELL_GUTTER.container)}>
        {/* The mark and the disclaimer are one unit, on a tighter gap than the row's, so the pill reads as a
            qualifier on the product name rather than as the first item in the bar. */}
        <div className="flex shrink-0 items-center gap-2">
          <Link to="/" aria-label="All applications">
            <img src="/wordmark.svg" alt="Autonoma" className="h-5 w-auto" />
          </Link>
          <EarlyVersionPill />
        </div>

        {sections.length > 0 && (
          <>
            <Separator orientation="vertical" className="h-5" />
            <TopNavSections sections={sections} activePath={activePath} />
          </>
        )}

        <span className="flex-1" />

        {upgrade}

        {/* Where you are, as one object: the organization, then the application inside it. Both are dropdowns,
            and they share an enclosure rather than standing apart because they name one place between them -
            two bordered pills would read as two unrelated controls that happen to sit together.

            The marker leads the pair rather than sitting inside the application segment, so it marks the scope
            rather than one half of it.

            The one thing in the bar allowed to give up width: narrow enough and the names truncate, which costs
            a few characters of something the page heading states in full - cheaper than any of the
            alternatives, all of which remove a control outright. */}
        {hasScope && (
          <span className="flex h-7 min-w-0 items-center overflow-hidden border border-border-dim bg-surface-base pl-2">
            <span className="block size-2 shrink-0 rounded-sm bg-primary" />
            {orgSwitcher}
            {orgSwitcher != null && appSwitcher != null && (
              <span className="shrink-0 text-sm text-text-secondary">/</span>
            )}
            {appSwitcher}
          </span>
        )}

        {account}
      </div>
    </header>
  );
}
