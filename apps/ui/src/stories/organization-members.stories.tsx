import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { dashboardFixtures } from "./app-home.stories";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The Members settings destination for an organization nobody can auto-join: two members and one
 * invitation still outstanding. Typechecked against `RouterOutputs["organization"]`.
 */
const membersFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  organization: {
    members: [
      {
        userId: "user_fixture_01",
        name: "Dana Whitfield",
        email: "dana@getacme.io",
        role: "owner",
        joinedAt: new Date("2026-05-12T09:24:00Z"),
        isSelf: true,
      },
      {
        userId: "user_fixture_02",
        name: "Marco Ferreira",
        email: "marco@getacme.io",
        role: "member",
        joinedAt: new Date("2026-07-02T14:05:00Z"),
        isSelf: false,
      },
    ],
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
    invitations: [
      {
        id: "inv_fixture_01",
        email: "priya@getacme.io",
        inviterName: "Dana Whitfield",
        expiresAt: new Date(Date.now() + 5 * DAY_MS),
        acceptUrl: "https://autonoma.app/invite/inv_fixture_01",
      },
    ],
  },
};

/** A one-person organization: nothing to revoke, and the only member cannot remove themselves. */
const soloFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  organization: {
    members: [
      {
        userId: "user_fixture_01",
        name: "Dana Whitfield",
        email: "dana@getacme.io",
        role: "owner",
        joinedAt: new Date("2026-05-12T09:24:00Z"),
        isSelf: true,
      },
    ],
    mine: [
      {
        id: "org_fixture_01",
        name: "Acme",
        slug: "acme",
        isActive: true,
        memberCount: 1,
        applicationCount: 1,
        joinedAt: new Date("2026-05-12T09:24:00Z"),
        // Their only organization, so leaving is refused whatever else is true.
        leaveBlockedReason: "last-organization" as const,
      },
    ],
    invitations: [],
  },
};

const meta = {
  title: "Pages/OrganizationMembers",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(membersFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/users` },
};

export const SingleMember: Story = {
  parameters: { msw: { handlers: appShellHandlers(soloFixtures) } },
  args: { path: `/app/${baseApplication.slug}/settings/users` },
};
