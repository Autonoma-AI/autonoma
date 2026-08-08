import type { Meta, StoryObj } from "@storybook/react-vite";
import { DryRunOutcomeNote } from "components/scenarios/dry-run-outcome-note";
import { trpcHandler } from "lib/storybook/trpc-handler";

/**
 * What a dry run leaves behind on the scenarios table. A failure's reason is often the only
 * account of what went wrong - a run that fails before the SDK call leaves no scenario
 * instance and no preview logs - so it stays on the card rather than in a toast.
 */
const meta = {
  title: "Components/DryRunOutcomeNote",
  component: DryRunOutcomeNote,
  parameters: {
    // The failure card's escape hatch carries a connect-agent dialog, which reads the org to
    // stay inert in the demo. That query runs even with the dialog closed.
    msw: {
      handlers: [
        trpcHandler({
          auth: {
            activeOrg: {
              id: "org_fixture_01",
              name: "Acme",
              slug: "acme",
              isDemo: false,
              canReturnToAccount: false,
              mergeGateEnabled: false,
              vercelMarketplaceEntry: false,
              invitesEnabled: true,
              needsNaming: false,
            },
          },
        }),
      ],
    },
  },
  decorators: [
    // Padding lives here so a docs screenshot of this card already has its own
    // margin - see the `ui-screenshots` skill on why the crop must not add it.
    (Story) => (
      <div className="mx-auto max-w-3xl bg-surface-void p-14">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DryRunOutcomeNote>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A recipe that never resolved: no SDK call, so no scenario instance and no preview logs to read. */
export const FailedBeforeTheSdkCall: Story = {
  args: {
    outcome: {
      success: false,
      error:
        "Unknown recipe variable: ownerEmail. The only tokens a recipe can use are {{testRunId}} and {{testRunShortId}}; every other value must be concrete.",
    },
  },
};

/** The SDK ran and rejected the data - the phase says how far the run got. */
export const FailedDuringUp: Story = {
  args: {
    outcome: {
      success: false,
      phase: "up",
      error:
        'SDK returned HTTP 500: null value in column "organization_id" of relation "account" violates not-null constraint',
    },
  },
};

export const Passed: Story = {
  args: { outcome: { success: true, phase: "down" } },
};
