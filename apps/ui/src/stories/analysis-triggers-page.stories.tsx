import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { dashboardFixtures } from "./app-home.stories";

/**
 * Fixtures for the analysis-triggers settings page: the app-shell chrome (from `dashboardFixtures`) plus this
 * page's trigger config. The automatic ready-for-review switch is off (the default) and the label is configurable.
 * Typechecked against `RouterOutputs["github"]["getTriggerConfig"]`.
 */
const triggerConfigFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getTriggerConfig: {
      autoRunOnReadyForReview: false,
      analysisTriggerLabel: "autonoma:analyze",
      repoFullName: "acme/checkout-web",
    },
  },
};

/** Same page with the automatic ready-for-review trigger switched on. */
const autoRunOnFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getTriggerConfig: {
      autoRunOnReadyForReview: true,
      analysisTriggerLabel: "acme:analyze",
      repoFullName: "acme/checkout-web",
    },
  },
};

/**
 * An org WITHOUT the merge gate enabled. The route loader redirects away from the triggers page, and the settings
 * chrome it lands on has no "Triggers" tab - proving the feature is hidden from clients not in the program.
 */
const gatedOffFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  auth: {
    activeOrg: {
      id: "org_fixture_01",
      name: "Acme",
      slug: "acme",
      isDemo: false,
      canReturnToAccount: false,
      mergeGateEnabled: false,
      vercelMarketplaceEntry: false,
      needsNaming: false,
    },
  },
};

const meta = {
  title: "Pages/AnalysisTriggers",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(triggerConfigFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/triggers` },
};

export const AutoRunEnabled: Story = {
  parameters: {
    msw: { handlers: appShellHandlers(autoRunOnFixtures) },
  },
  args: { path: `/app/${baseApplication.slug}/settings/triggers` },
};

/** Merge gate off: visiting the triggers URL redirects to settings, which shows no "Triggers" tab. */
export const GatedOff: Story = {
  parameters: {
    msw: { handlers: appShellHandlers(gatedOffFixtures) },
  },
  args: { path: `/app/${baseApplication.slug}/settings/triggers` },
};
