import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

/**
 * A personal-email organization that has never been named: `needsNaming` is true, and the field is
 * prefilled with the auto-derived guess (the name of whoever signed up first).
 */
const unnamedOrganization: TrpcFixtures = {
  auth: {
    activeOrg: {
      id: "org_fixture_01",
      name: "Dana Whitfield",
      slug: "dana-whitfield",
      isDemo: false,
      canReturnToAccount: false,
      mergeGateEnabled: false,
      vercelMarketplaceEntry: false,
      needsNaming: true,
    },
  },
};

const meta = {
  title: "Pages/NameOrganization",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(unnamedOrganization) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const PrefilledWithTheirName: Story = {
  args: { path: "/name-organization" },
};
