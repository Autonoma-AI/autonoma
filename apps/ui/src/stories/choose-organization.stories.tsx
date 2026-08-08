import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

/**
 * Where every sign-in lands. An account in one organization is forwarded straight through by the
 * loader and never sees this, so the story that matters is the multi-organization one.
 */
const twoOrganizations: TrpcFixtures = {
  organization: {
    mine: [
      {
        id: "org_fixture_01",
        name: "Acme",
        slug: "acme",
        isActive: true,
        memberCount: 2,
        applicationCount: 1,
        joinedAt: new Date("2026-05-12T09:24:00Z"),
      },
      {
        id: "org_fixture_02",
        name: "Northwind QA",
        slug: "northwind-qa",
        isActive: false,
        memberCount: 4,
        applicationCount: 3,
        joinedAt: new Date("2026-06-30T11:00:00Z"),
      },
    ],
  },
};

const meta = {
  title: "Pages/ChooseOrganization",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(twoOrganizations) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const TwoOrganizations: Story = {
  args: { path: "/choose-organization" },
};
