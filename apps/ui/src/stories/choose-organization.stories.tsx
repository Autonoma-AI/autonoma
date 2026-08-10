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

/**
 * The shape that broke it: staff and anyone consulting for several customers accumulate memberships,
 * and the list grows a row for each. Twenty-four is what one real account had.
 */
const manyOrganizations: TrpcFixtures = {
  organization: {
    mine: [
      "Autonoma",
      "Longevo",
      "Horizon",
      "Celllabs",
      "Usehorizon",
      "Sytrex",
      "Homa",
      "Sandstone",
      "Eddi",
      "Autometa",
      "Agree",
      "Centinel",
      "Volantisedu",
      "onecrew",
      "Coderhouse",
      "Eon",
      "Eonrides",
      "Northwind Bank",
      "Qualitate",
      "Purecobalt",
      "Newagesysit",
      "Liveflow",
      "Assignar",
      "Bettermode",
    ].map((name, index) => ({
      id: `org_fixture_${index}`,
      name,
      slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      isActive: index === 0,
      memberCount: 2 + (index % 18),
      applicationCount: index % 12,
      joinedAt: new Date("2026-05-12T09:24:00Z"),
    })),
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

/**
 * Twenty-four organizations, which is taller than a laptop viewport. The frame used to centre the
 * list in a fixed-height flex container with no scroller, so the overflow went off BOTH ends and the
 * heading and first rows sat at negative coordinates - unreachable, because `scrollTop` cannot go
 * below zero. Shoot this one short (e.g. `--viewport 1280x800`) or it proves nothing.
 */
export const ManyOrganizations: Story = {
  args: { path: "/choose-organization" },
  parameters: { msw: { handlers: appShellHandlers(manyOrganizations) } },
};
