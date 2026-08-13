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
 * Where the tabs sit, and whether they are enclosed.
 *
 * Centring them turned out to have a defect the drawings did not show: they are centred with `flex-1`, so they
 * move when the right-hand group changes size - about 110px between a paying, set-up organization and a new one
 * with both calls to action on screen. A navigation control that shifts with your billing state is worse than
 * any of the grouping differences.
 *
 * **Left-aligning fixes that outright**, with no `flex-1` and nothing to shift, which also means Upgrade can stay
 * a filled call to action in the bar rather than being moved out to hold the tabs still.
 *
 * Every option below is shown in both states, so "the tabs do not move" is something to check rather than take on
 * trust. The left is now only the wordmark and the tabs - the switcher moved right - so there is far less for the
 * tabs to be confused with than in the draft that made them one enclosed object in the middle.
 */

const SECTIONS: AppNavItem[] = [
  { icon: GitPullRequestIcon, label: "Pull Requests", href: "/app/acme-web/pull-requests" },
  { icon: BugIcon, label: "Tests", href: "/app/acme-web/tests" },
];

const ACTIVE_PATH = "/app/acme-web/pull-requests";

/** Roughly a quarter of the way in: off the brand, without committing to the middle. */
const OFFSET_LEFT = 220;

function Wordmark() {
  return <img src="/wordmark.svg" alt="Autonoma" className="h-5 w-auto shrink-0" />;
}

function Sections({ enclosed = false }: { enclosed?: boolean }) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center",
        enclosed && "overflow-hidden border border-border-dim bg-surface-base",
      )}
    >
      <TopNavSections sections={SECTIONS} activePath={ACTIVE_PATH} />
    </span>
  );
}

/** The application, as one object: which one, and how it is doing. */
function AppGroup() {
  return (
    <span className="flex shrink-0 items-center overflow-hidden border border-border-dim bg-surface-base">
      <span className="flex min-w-0 items-center gap-2 px-2 py-1 text-sm">
        <span className="block size-2 shrink-0 rounded-sm bg-primary" />
        <span className="hidden min-w-0 truncate text-text-secondary lg:block">Acme /</span>
        <span className="min-w-0 truncate font-medium text-text-primary">Acme Web</span>
        <CaretUpDownIcon size={12} className="shrink-0 text-text-secondary" />
      </span>
      <Separator orientation="vertical" className="h-5" />
      <span className="flex shrink-0 items-center gap-2 px-2">
        <SuiteHealthBars health={baseSuiteHealth} />
        <span className="hidden lg:block">
          <SuiteHealthPill health={baseSuiteHealth} />
        </span>
      </span>
    </span>
  );
}

function You() {
  return (
    <>
      <Button variant="ghost" size="icon-sm" className="shrink-0 text-text-secondary">
        <ChatCircleDotsIcon size={16} />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="shrink-0 border border-border-dim font-mono text-2xs uppercase text-text-secondary"
      >
        j
      </Button>
    </>
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

function Bar({ left, worst }: { left: ReactNode; worst: boolean }) {
  return (
    <div className="flex h-14 items-center gap-3 border-b border-border-dim bg-surface-void px-8">
      {left}
      <span className="flex-1" />
      <Ctas show={worst} />
      <AppGroup />
      <You />
    </div>
  );
}

function Pair({ caption, note, left }: { caption: string; note: string; left: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-2xs uppercase tracking-widest text-primary">{caption}</span>
        <span className="max-w-4xl text-xs leading-relaxed text-text-secondary">{note}</span>
      </div>
      <div className="flex flex-col border border-border-dim">
        <span className="bg-surface-base px-3 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary">
          steady
        </span>
        <Bar left={left} worst={false} />
        <span className="bg-surface-base px-3 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary">
          worst · both calls to action
        </span>
        <Bar left={left} worst />
      </div>
    </div>
  );
}

const meta = {
  title: "Nav/TabPlacement",
  component: Bar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Bar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Options: Story = {
  args: { left: null, worst: false },
  render: () => (
    <div className="flex flex-col gap-8 bg-surface-base p-8">
      <Pair
        caption="K1 · hard left, straight after the wordmark, not enclosed"
        note="The most conventional bar there is. The active tab's accent edge lands close to the wordmark, which is the one thing to look at - it can read as though the mark were part of the tab strip."
        left={
          <>
            <Wordmark />
            <Sections />
          </>
        }
      />

      <Pair
        caption="K2 · hard left with a rule between brand and navigation (proposed)"
        note="The rule does the work the enclosure was doing, at a fraction of the weight: it says the wordmark is not one of the tabs, and nothing else. Tabs start at a fixed offset, so they never move."
        left={
          <>
            <Wordmark />
            <Separator orientation="vertical" className="h-5" />
            <Sections />
          </>
        }
      />

      <Pair
        caption="K3 · offset left, about a quarter of the way in"
        note="Off the brand without committing to the middle, and the gap alone separates them - no rule needed. It buys air at the cost of a magic number that has no reason to be that number."
        left={
          <>
            <Wordmark />
            <span style={{ width: OFFSET_LEFT }} />
            <Sections />
          </>
        }
      />

      <Pair
        caption="K4 · hard left, still enclosed"
        note="The same position as K2 with the container kept, for comparison. Now that the switcher has moved right, the enclosure is defending against a crowd that is no longer there - and it makes the tabs the heaviest thing on the left."
        left={
          <>
            <Wordmark />
            <Separator orientation="vertical" className="h-5" />
            <Sections enclosed />
          </>
        }
      />
    </div>
  ),
};
