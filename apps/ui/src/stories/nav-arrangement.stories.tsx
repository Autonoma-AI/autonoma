import { Button, Separator, cn } from "@autonoma/blacklight";
import { BugIcon } from "@phosphor-icons/react/Bug";
import { CaretUpDownIcon } from "@phosphor-icons/react/CaretUpDown";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SuiteHealthBars, SuiteHealthPill } from "components/suite-health/suite-health-meter";
import { baseSuiteHealth } from "lib/storybook/base-fixtures";
import type { ReactNode } from "react";
import { TopNavSections } from "routes/_blacklight/_app-shell/-layout/top-nav-sections";
import type { AppNavItem } from "routes/_blacklight/_app-shell/-layout/use-app-nav";

/**
 * Brand on the left, navigation in the middle, everything scoped to you and your application on the right.
 *
 * This groups the right-hand end by **what a thing is about** rather than by what it happens to be: the switcher
 * and the suite-health meter are both statements about this application, and the account menu already holds
 * settings, billing and sign-out. So the right reads as `[ this application ] │ [ you ]`, with the transient
 * calls to action ahead of both.
 *
 * The cost is worth looking at before choosing: moving the switcher right leaves the left holding only the
 * wordmark, so the bar can end up lopsided - and the right-hand end now carries five things in the worst case
 * where it previously carried four. Each option below is shown in the steady state and in that worst case.
 */

const SECTIONS: AppNavItem[] = [
  { icon: GitPullRequestIcon, label: "Pull Requests", href: "/app/acme-web/pull-requests" },
  { icon: BugIcon, label: "Tests", href: "/app/acme-web/tests" },
];

const ACTIVE_PATH = "/app/acme-web/pull-requests";

function Wordmark() {
  return <img src="/wordmark.svg" alt="Autonoma" className="h-5 w-auto shrink-0" />;
}

function Switcher({ compact = false }: { compact?: boolean }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2 text-sm", compact ? "px-2 py-1" : "px-2 py-1.5")}>
      <span className="block size-2 shrink-0 rounded-sm bg-primary" />
      <span className="hidden min-w-0 truncate text-text-secondary lg:block">Acme /</span>
      <span className="min-w-0 truncate font-medium text-text-primary">Acme Web</span>
      <CaretUpDownIcon size={12} className="shrink-0 text-text-secondary" />
    </span>
  );
}

function Health({ withPill = true }: { withPill?: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-2 px-2">
      <SuiteHealthBars health={baseSuiteHealth} />
      {withPill && (
        <span className="hidden lg:block">
          <SuiteHealthPill health={baseSuiteHealth} />
        </span>
      )}
    </span>
  );
}

function Account() {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className="shrink-0 border border-border-dim font-mono text-2xs uppercase text-text-secondary"
    >
      j
    </Button>
  );
}

function Feedback() {
  return (
    <Button variant="ghost" size="icon-sm" className="shrink-0 text-text-secondary">
      <ChatCircleDotsIcon size={16} />
    </Button>
  );
}

function Ctas({ show }: { show: boolean }) {
  if (!show) return undefined;
  return (
    <>
      <Button variant="outline" size="xs" className="shrink-0 gap-1.5 border-primary/40 text-primary">
        <SlidersHorizontalIcon size={13} />
        Finish setup
      </Button>
      <Button variant="cta" size="xs" className="shrink-0 gap-1.5">
        <CrownSimpleIcon size={13} weight="fill" />
        Upgrade
      </Button>
    </>
  );
}

function Rule() {
  return <Separator orientation="vertical" className="h-5" />;
}

function Bar({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-14 items-center gap-3 border-b border-border-dim bg-surface-void px-8">
      <Wordmark />
      <span className="flex min-w-0 flex-1 justify-center">
        <TopNavSections sections={SECTIONS} activePath={ACTIVE_PATH} />
      </span>
      {children}
    </div>
  );
}

function Pair({ caption, note, render }: { caption: string; note: string; render: (worst: boolean) => ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-2xs uppercase tracking-widest text-primary">{caption}</span>
        <span className="max-w-4xl text-xs leading-relaxed text-text-secondary">{note}</span>
      </div>
      <div className="flex flex-col border border-border-dim">
        <span className="bg-surface-base px-3 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary">
          steady · paying, set up
        </span>
        <Bar>{render(false)}</Bar>
        <span className="bg-surface-base px-3 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary">
          worst · new org, setup outstanding
        </span>
        <Bar>{render(true)}</Bar>
      </div>
    </div>
  );
}

const meta = {
  title: "Nav/Arrangement",
  component: Bar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Bar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Options: Story = {
  args: { children: null },
  render: () => (
    <div className="flex flex-col gap-8 bg-surface-base p-8">
      <Pair
        caption="J1 · two groups, separated by rules"
        note="The application and you, told apart by a rule rather than by a container. Lightest touch, and the grouping is only as strong as the rule is visible."
        render={(worst) => (
          <>
            <Ctas show={worst} />
            <Rule />
            <Switcher />
            <Health />
            <Rule />
            <Feedback />
            <Account />
          </>
        )}
      />

      <Pair
        caption="J2 · the application is one enclosed object (proposed)"
        note="Which application, and how it is doing, inside one border - the same enclosure the tabs use, so the bar reads as three objects: brand, navigation, application, and then you. The strongest statement that the switcher and the meter are the same subject."
        render={(worst) => (
          <>
            <Ctas show={worst} />
            <span className="flex shrink-0 items-center overflow-hidden border border-border-dim bg-surface-base">
              <Switcher compact />
              <Separator orientation="vertical" className="h-5" />
              <Health />
            </span>
            <Feedback />
            <Account />
          </>
        )}
      />

      <Pair
        caption="J3 · application enclosed, and you enclosed with it"
        note="Takes 'user and settings close' literally: the account sits inside the same container, one divider along. Fewest separate objects in the bar - and it says you are part of the application, which you are not."
        render={(worst) => (
          <>
            <Ctas show={worst} />
            <span className="flex shrink-0 items-center overflow-hidden border border-border-dim bg-surface-base">
              <Switcher compact />
              <Separator orientation="vertical" className="h-5" />
              <Health />
              <Separator orientation="vertical" className="h-5" />
              <Feedback />
              <Account />
            </span>
          </>
        )}
      />

      <Pair
        caption="J4 · J2, with the calls to action out of the bar"
        note="Finish setup becomes a banner under the bar and Upgrade moves into the account menu, so the worst case stops being a different layout from the steady one. The bar is then the same shape for everybody, always - at the cost of burying Upgrade, which is a revenue decision."
        render={() => (
          <>
            <span className="flex shrink-0 items-center overflow-hidden border border-border-dim bg-surface-base">
              <Switcher compact />
              <Separator orientation="vertical" className="h-5" />
              <Health />
            </span>
            <Feedback />
            <Account />
          </>
        )}
      />
    </div>
  ),
};
