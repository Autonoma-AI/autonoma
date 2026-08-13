import { Button, Separator } from "@autonoma/blacklight";
import { BugIcon } from "@phosphor-icons/react/Bug";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { CaretUpDownIcon } from "@phosphor-icons/react/CaretUpDown";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { GitPullRequestIcon } from "@phosphor-icons/react/GitPullRequest";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SuiteHealthBars, SuiteHealthPill } from "components/suite-health/suite-health-meter";
import { baseSuiteHealth } from "lib/storybook/base-fixtures";
import type { ReactNode } from "react";
import { TopNavBar } from "routes/_blacklight/_app-shell/-layout/top-nav-bar";
import { TopNavSections } from "routes/_blacklight/_app-shell/-layout/top-nav-sections";
import type { AppNavItem } from "routes/_blacklight/_app-shell/-layout/use-app-nav";

/**
 * The navigation choices this pull request is asking for a decision on.
 *
 * Each story renders the real components with realistic data and holds everything but the one axis in question
 * constant, so the options can be compared rather than imagined. Whatever is picked, the losing options and the
 * props that select them come out before this is marked ready.
 */

const TABLET = 760;
/** Wide enough that nothing in the bar has collapsed, so the horizontal-scroll option shows what it hides. */
const BAR_NATURAL_WIDTH = 1100;

/** Stories render a reader who is on Pull Requests; the memory router behind a component story is not. */
const ACTIVE_PATH = "/app/acme-web/pull-requests";

const SECTIONS: AppNavItem[] = [
  { icon: GitPullRequestIcon, label: "Pull Requests", href: "/app/acme-web/pull-requests" },
  { icon: BugIcon, label: "Tests", href: "/app/acme-web/tests" },
];

function AppSwitcherStandIn() {
  return (
    <span className="flex min-w-0 max-w-56 items-center gap-2 px-2 py-1.5 text-sm">
      <span className="block size-2 shrink-0 rounded-sm bg-primary" />
      <span className="hidden min-w-0 truncate text-text-secondary lg:block">Acme /</span>
      <span className="min-w-0 truncate font-medium text-text-primary">Acme Web</span>
      <CaretUpDownIcon size={12} className="shrink-0 text-text-secondary" />
    </span>
  );
}

function SuiteHealthStandIn() {
  return (
    <span className="flex items-center gap-2 px-2 py-1">
      <SuiteHealthBars health={baseSuiteHealth} />
      <span className="hidden lg:block">
        <SuiteHealthPill health={baseSuiteHealth} />
      </span>
    </span>
  );
}

function UpgradeStandIn() {
  return (
    <Button variant="cta" size="xs" className="gap-1.5">
      <CrownSimpleIcon size={13} weight="fill" />
      <span className="hidden md:inline">Upgrade</span>
    </Button>
  );
}

function AccountStandIn({ trigger = "initial" }: { trigger?: "initial" | "named" | "caret" }) {
  if (trigger === "named") {
    return (
      <Button variant="ghost" size="xs" className="shrink-0 gap-2 text-text-secondary">
        <span className="grid size-5 shrink-0 place-items-center border border-border-dim font-mono text-3xs uppercase">
          j
        </span>
        <span className="max-w-28 truncate">jrivera</span>
      </Button>
    );
  }
  if (trigger === "caret") {
    return (
      <Button variant="ghost" size="xs" className="shrink-0 gap-1 text-text-secondary">
        <span className="grid size-5 shrink-0 place-items-center border border-border-dim font-mono text-3xs uppercase">
          j
        </span>
        <CaretDownIcon size={11} />
      </Button>
    );
  }
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

function Option({
  caption,
  note,
  width,
  children,
}: {
  caption: string;
  note: string;
  /** Simulates a viewport. The frame takes this width, so the bar inside fills it exactly as it would on screen. */
  width?: number;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-2xs uppercase tracking-widest text-primary">{caption}</span>
        <span className="text-xs text-text-secondary">{note}</span>
      </div>
      <div className="border border-border-dim bg-surface-void" style={width != null ? { width } : undefined}>
        {children}
      </div>
    </div>
  );
}

function Wordmark() {
  return <img src="/wordmark.svg" alt="Autonoma" className="h-5 w-auto shrink-0" />;
}

/** The application as one object, exactly as `TopNavBar` composes it. */
function AppGroup() {
  return (
    <span className="flex shrink-0 items-center overflow-hidden border border-border-dim bg-surface-base">
      <AppSwitcherStandIn />
      <Separator orientation="vertical" className="h-5" />
      <SuiteHealthStandIn />
    </span>
  );
}

/**
 * The bar at a narrow width, with the sections replaced by whatever the option does to them. Everything else is
 * held at what the bar actually ships, so the only thing being judged is the collapse.
 *
 * Feedback is absent on purpose: it is `md:inline-flex`, and 760px is below that breakpoint, so it is already
 * folded into the account menu here.
 */
function NarrowBar({ sections }: { sections: ReactNode }) {
  return (
    <div className="flex h-14 items-center gap-3 px-8">
      <Wordmark />
      <Separator orientation="vertical" className="h-5" />
      {sections}
      <span className="flex-1" />
      <AppGroup />
      <AccountStandIn />
    </div>
  );
}

function Board({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-8 bg-surface-base p-8">{children}</div>;
}

function Bar({
  withUpgrade = true,
  accountTrigger,
}: {
  withUpgrade?: boolean;
  accountTrigger?: "initial" | "named" | "caret";
}) {
  return (
    <TopNavBar
      sections={SECTIONS}
      appSwitcher={<AppSwitcherStandIn />}
      upgrade={withUpgrade ? <UpgradeStandIn /> : undefined}
      account={<AccountStandIn trigger={accountTrigger} />}
      activePath={ACTIVE_PATH}
    />
  );
}

const meta = {
  title: "Nav/DecisionBoard",
  component: TopNavBar,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TopNavBar>;

export default meta;
type Story = StoryObj<typeof meta>;

const BASE_ARGS = {
  sections: SECTIONS,
  account: null,
};

/**
 * What gives below ~900px, where the bar runs out of room.
 *
 * This is a stub rather than a preference: today the bar simply collides at this width. Each option is rendered in
 * a frame that IS 760px, so the bar fills it the way it would fill a real screen of that size.
 */
export const Narrow: Story = {
  args: BASE_ARGS,
  render: () => (
    <Board>
      <Option
        caption="collapse to one dropdown"
        note="The section you are on names itself and the rest sit behind it. Keeps every label, costs a click."
        width={TABLET}
      >
        <NarrowBar
          sections={
            <Button variant="ghost" size="xs" className="shrink-0 gap-1.5 border-l-2 border-primary">
              <GitPullRequestIcon size={16} weight="fill" />
              Pull Requests
              <CaretDownIcon size={11} />
            </Button>
          }
        />
      </Option>

      <Option
        caption="icon-only with tooltips"
        note="Everything stays one click away. The labels go, and two similar icons become a guess."
        width={TABLET}
      >
        <NarrowBar
          sections={
            <span className="flex shrink-0 items-center gap-1">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Pull Requests"
                className="border-l-2 border-primary text-text-primary"
              >
                <GitPullRequestIcon size={16} weight="fill" />
              </Button>
              <Button variant="ghost" size="icon-sm" aria-label="Tests" className="text-text-secondary">
                <BugIcon size={16} />
              </Button>
            </span>
          }
        />
      </Option>

      <Option
        caption="scroll horizontally"
        note="Nothing collapses and nothing is hidden - the bar simply overflows and you drag it. Honest, and it looks like a mistake."
        width={TABLET}
      >
        <div className="overflow-x-auto">
          <div style={{ width: BAR_NATURAL_WIDTH }}>
            <NarrowBar sections={<TopNavSections sections={SECTIONS} activePath={ACTIVE_PATH} />} />
          </div>
        </div>
      </Option>

      <Option
        caption="wrap to a second row"
        note="Every label survives, at 56px of extra vertical exactly when the screen has least of it to spare."
        width={TABLET}
      >
        <div>
          <div className="flex h-14 items-center gap-3 px-8">
            <Wordmark />
            <span className="flex-1" />
            <AppGroup />
            <AccountStandIn />
          </div>
          <div className="flex h-12 items-center border-t border-border-dim px-8">
            <TopNavSections sections={SECTIONS} activePath={ACTIVE_PATH} />
          </div>
        </div>
      </Option>
    </Board>
  ),
};

/**
 * Which of these is in the product: **avatar and name**.
 *
 * The initial square shipped first and lost on a reading nobody had predicted from a static board - a bordered
 * square holding one glyph is the exact shape of every icon button in the product, so it read as a control that
 * did something rather than as who you are signed in as. Its width argument turned out to be affordable: the
 * name hides below `lg`, which is where the bar is actually tight, so the ~140px is only ever spent on a screen
 * with room for it.
 */
export const AccountTrigger: Story = {
  args: BASE_ARGS,
  render: () => (
    <Board>
      <Option
        caption="initial square"
        note="Smallest, and it matches the mono/square language the rest of the chrome uses - which is the problem: it matches the icon buttons too, and reads as an action."
      >
        <Bar accountTrigger="initial" />
      </Option>
      <Option
        caption="avatar and name (chosen)"
        note="Most legible, and unmistakably a person rather than a button. Costs ~140px, spent only at `lg` and above."
      >
        <Bar accountTrigger="named" />
      </Option>
      <Option
        caption="initial and caret"
        note="Signals 'this opens' without spending width on a name you already know."
      >
        <Bar accountTrigger="caret" />
      </Option>
    </Board>
  ),
};
