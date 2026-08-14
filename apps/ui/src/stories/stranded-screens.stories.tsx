import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";

/**
 * The screens a member can be stranded on, and the way off them.
 *
 * Each of these renders outside the app shell, so the bar that carries the organization switcher is not there:
 * an organization awaiting approval, one that was rejected, one with no applications yet. Every one of them
 * offered nothing but Sign out, which is fine when it is your only organization and a dead end when it is not -
 * and an internal admin never met it, because `/admin` is an explicit exemption from the same redirects.
 *
 * Two organizations in every fixture here, because with one there is nothing to offer and the button correctly
 * does not render.
 */

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

const TWO_ORGS: RouterOutputs["organization"]["mine"] = [
  {
    id: "org_fixture_01",
    name: "Acme",
    slug: "acme",
    isActive: true,
    memberCount: 4,
    applicationCount: 0,
    joinedAt: FIXTURE_EPOCH,
  },
  {
    id: "org_fixture_02",
    name: "Northwind",
    slug: "northwind",
    isActive: false,
    memberCount: 2,
    applicationCount: 1,
    joinedAt: FIXTURE_EPOCH,
  },
];

const handlers = appShellHandlers({ organization: { mine: TWO_ORGS } });

const meta = {
  title: "Nav/StrandedScreens",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen", msw: { handlers } },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Where a member lands when the session points at an organization still awaiting approval. */
export const Pending: Story = {
  args: { path: "/pending" },
};

/** The same dead end, for an organization whose request was turned down. */
export const Rejected: Story = {
  args: { path: "/rejected" },
};

/** The full-page picker the button leads to, which already existed and does the switching. */
export const ChooseOrganization: Story = {
  args: { path: "/choose-organization" },
};
