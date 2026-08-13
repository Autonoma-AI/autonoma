import { Button, Separator } from "@autonoma/blacklight";
import { CaretDownIcon } from "@phosphor-icons/react/CaretDown";
import { ChatCircleDotsIcon } from "@phosphor-icons/react/ChatCircleDots";
import { CrownSimpleIcon } from "@phosphor-icons/react/CrownSimple";
import { QuestionIcon } from "@phosphor-icons/react/Question";
import { SlidersHorizontalIcon } from "@phosphor-icons/react/SlidersHorizontal";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { SuiteHealthBars, SuiteHealthPill } from "components/suite-health/suite-health-meter";
import { baseSuiteHealth } from "lib/storybook/base-fixtures";
import type { ReactNode } from "react";

/**
 * The right-hand end of the top bar, on its own.
 *
 * What is there today is five items from four different scopes with three different lifetimes and five different
 * visual treatments - and two of them (the meter, the feedback bubble) carry no visible text at all, so you have
 * to hover to learn what they are.
 *
 * The deeper problem is a category error rather than a styling one: **suite health and Finish setup are about the
 * application**, and they sit beside "who you are" and "give us money". The pull request list already carries an
 * application-status readout in its header - the MAIN chip - so there is somewhere better for them to be.
 *
 * Each option is shown twice, because the cluster is worst in the case that is rarest. `steady` is a paying,
 * set-up organization, which is what almost everyone sees almost always. `worst` is a brand-new unsubscribed
 * organization with setup outstanding, which is when every conditional item is on screen at once.
 */

const SUITE_HEALTH_TONE = "text-text-secondary";

function Meter({ labelled = false }: { labelled?: boolean }) {
  return (
    <span className="flex items-center gap-2 px-1">
      {labelled && (
        <span className={`font-mono text-3xs uppercase tracking-widest ${SUITE_HEALTH_TONE}`}>Suite health</span>
      )}
      <SuiteHealthBars health={baseSuiteHealth} />
      <SuiteHealthPill health={baseSuiteHealth} />
    </span>
  );
}

function FinishSetup({ labelled = true }: { labelled?: boolean }) {
  return (
    <Button variant="outline" size="xs" className="shrink-0 gap-1.5 border-primary/40 text-primary">
      <SlidersHorizontalIcon size={13} />
      {labelled && "Finish setup"}
    </Button>
  );
}

function Upgrade() {
  return (
    <Button variant="cta" size="xs" className="shrink-0 gap-1.5">
      <CrownSimpleIcon size={13} weight="fill" />
      Upgrade
    </Button>
  );
}

function FeedbackIcon() {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Send feedback" className="shrink-0 text-text-secondary">
      <ChatCircleDotsIcon size={16} />
    </Button>
  );
}

function FeedbackLabelled() {
  return (
    <Button variant="ghost" size="xs" className="shrink-0 gap-1.5 text-text-secondary">
      <ChatCircleDotsIcon size={14} />
      Feedback
    </Button>
  );
}

function HelpMenu() {
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Help and feedback" className="shrink-0 text-text-secondary">
      <QuestionIcon size={16} />
    </Button>
  );
}

function Account({ labelled = false }: { labelled?: boolean }) {
  if (labelled) {
    return (
      <Button variant="ghost" size="xs" className="shrink-0 gap-2 text-text-secondary">
        <span className="grid size-5 shrink-0 place-items-center border border-border-dim font-mono text-3xs uppercase">
          j
        </span>
        jrivera
        <CaretDownIcon size={11} />
      </Button>
    );
  }
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Account: jrivera"
      className="shrink-0 border border-border-dim font-mono text-2xs uppercase text-text-secondary"
    >
      j
    </Button>
  );
}

/** A bar-height strip, so each cluster is judged at the size it will actually be. */
function Strip({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-14 items-center justify-end gap-3 border-b border-border-dim bg-surface-void px-8">
      {children}
    </div>
  );
}

function Option({
  caption,
  note,
  steady,
  worst,
}: {
  caption: string;
  note: string;
  steady: ReactNode;
  worst: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-0.5">
        <span className="font-mono text-2xs uppercase tracking-widest text-primary">{caption}</span>
        <span className="max-w-3xl text-xs leading-relaxed text-text-secondary">{note}</span>
      </div>
      <div className="grid grid-cols-2 border border-border-dim">
        <div className="border-r border-border-dim">
          <span className="block bg-surface-base px-3 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary">
            steady · paying, set up
          </span>
          <Strip>{steady}</Strip>
        </div>
        <div>
          <span className="block bg-surface-base px-3 py-1 font-mono text-4xs uppercase tracking-widest text-text-secondary">
            worst · new org, setup outstanding
          </span>
          <Strip>{worst}</Strip>
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: "Nav/RightCluster",
  component: Strip,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Strip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Options: Story = {
  args: { children: null },
  render: () => (
    <div className="flex flex-col gap-8 bg-surface-base p-8">
      <Option
        caption="today · what is on the branch now"
        note="Five items, four scopes, three lifetimes, five treatments. The meter and the feedback bubble have no visible text, so you hover to find out what they are."
        steady={
          <>
            <Meter />
            <FeedbackIcon />
            <Account />
          </>
        }
        worst={
          <>
            <FinishSetup />
            <Meter />
            <Upgrade />
            <FeedbackIcon />
            <Account />
          </>
        }
      />

      <Option
        caption="R1 · move application state out of the chrome (recommended)"
        note="Suite health goes to the application's own surfaces, beside the MAIN chip that already reports on it; Finish setup becomes a banner under the bar. What is left is only about you and your organization - two objects in the steady state, one category."
        steady={<Account />}
        worst={
          <>
            <Upgrade />
            <Account />
          </>
        }
      />

      <Option
        caption="R2 · keep everything, group it by category"
        note="Same five items, but stated as three groups behind rules: status, then the task, then meta. One treatment per group - status quiet, tasks the only filled things, meta as ghost icons."
        steady={
          <>
            <Meter />
            <Separator orientation="vertical" className="h-5" />
            <FeedbackIcon />
            <Account />
          </>
        }
        worst={
          <>
            <Meter />
            <Separator orientation="vertical" className="h-5" />
            <FinishSetup />
            <Upgrade />
            <Separator orientation="vertical" className="h-5" />
            <FeedbackIcon />
            <Account />
          </>
        }
      />

      <Option
        caption="R3 · one help trigger instead of a feedback bubble"
        note="Feedback, docs, keyboard shortcuts and the changelog go behind a single question mark, so the bar stops growing an icon every time we add a meta surface."
        steady={
          <>
            <Meter />
            <Separator orientation="vertical" className="h-5" />
            <HelpMenu />
            <Account />
          </>
        }
        worst={
          <>
            <Meter />
            <Separator orientation="vertical" className="h-5" />
            <FinishSetup />
            <Upgrade />
            <Separator orientation="vertical" className="h-5" />
            <HelpMenu />
            <Account />
          </>
        }
      />

      <Option
        caption="R4 · the account menu absorbs everything but status"
        note="Feedback, billing, upgrade, settings and sign-out all live in the menu. The fewest objects of any option - and burying Upgrade is a revenue decision rather than a design one, so it should be made deliberately."
        steady={
          <>
            <Meter />
            <Account />
          </>
        }
        worst={
          <>
            <Meter />
            <FinishSetup />
            <Account />
          </>
        }
      />

      <Option
        caption="R5 · change nothing, label everything"
        note="The narrowest possible fix for 'it is not clear what these do': every item says what it is. Nothing moves and nothing is grouped, so it costs the most width and leaves the category mismatch in place."
        steady={
          <>
            <Meter labelled />
            <FeedbackLabelled />
            <Account labelled />
          </>
        }
        worst={
          <>
            <Meter labelled />
            <FinishSetup />
            <Upgrade />
            <FeedbackLabelled />
            <Account labelled />
          </>
        }
      />
    </div>
  ),
};
