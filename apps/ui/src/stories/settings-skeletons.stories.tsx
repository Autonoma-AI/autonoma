import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { BillingSkeleton } from "routes/_blacklight/_app-shell/app.$appSlug/settings/billing/-billing-skeleton";
import { AnalysisTriggersSkeleton } from "routes/_blacklight/_app-shell/app.$appSlug/settings/triggers/index";

/**
 * Settings destinations paint these while their loader runs. The settings rail is deliberately absent: it
 * belongs to the parent layout route, which keeps rendering it around the Outlet these fill, so a slow
 * destination can still be left by clicking another one.
 *
 * Screenshots of these run with motion disabled, so `animate-pulse` is off and each bar renders flat. That
 * is the state worth checking - a skeleton has to read as a placeholder without the animation carrying it,
 * and in particular has to stay visible against the panel it sits inside.
 */
function ContentColumn({ children }: { children: ReactNode }) {
  return <div className="min-w-0 max-w-3xl bg-surface-void p-6">{children}</div>;
}

const meta = {
  title: "Settings/Skeletons",
  component: ContentColumn,
} satisfies Meta<typeof ContentColumn>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * Billing. The four stat cards are real `Panel` chrome with only their contents standing in - the border and
 * header are static and already known, so skeletoning them would be a worse guess than drawing them.
 */
export const Billing: Story = {
  args: { children: <BillingSkeleton /> },
};

/** Triggers, reusing the skeleton the page already had for its inner Suspense boundary. */
export const Triggers: Story = {
  args: { children: <AnalysisTriggersSkeleton /> },
};
