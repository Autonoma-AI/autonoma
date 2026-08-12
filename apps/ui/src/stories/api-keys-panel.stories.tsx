import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { userEvent, within } from "storybook/test";
import { dashboardFixtures } from "./app-home.stories";

/** The signed-in user in the app-shell session fixture (Ada Lovelace), so one key reads as "mine". */
const SIGNED_IN_USER_ID = "user_fixture_01";

// Relative, not fixed: the dialog renders "today"/"N days ago" against now, so a hardcoded
// date would drift into an ever-growing day count and the copy under test would change.
const USED_TODAY = new Date(Date.now() - 2 * 60 * 60 * 1000);
const USED_LAST_WEEK = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);

const apiKeyFixtures: TrpcFixtures = {
  // The settings rail sits inside the app shell, which reads the dashboard's procedures on the way
  // in - without them the page renders its error boundary rather than this panel.
  ...dashboardFixtures,
  apiKeys: {
    list: [
      {
        id: "key_fixture_01",
        name: "CI Pipeline",
        start: "ask_9f2",
        createdAt: new Date("2026-01-04T09:00:00.000Z"),
        lastRequest: USED_LAST_WEEK,
        ownerLeft: false,
        user: { id: "user_fixture_02", name: "Paula Ferreyra", email: "paula@acme.com" },
      },
      {
        id: "key_fixture_02",
        name: "Local development",
        start: "ask_41c",
        createdAt: new Date("2026-01-06T14:30:00.000Z"),
        lastRequest: USED_TODAY,
        ownerLeft: false,
        user: { id: SIGNED_IN_USER_ID, name: "Ada Lovelace", email: "ada@acme.com" },
      },
      {
        id: "key_fixture_03",
        name: "Staging smoke tests",
        start: "ask_7b0",
        createdAt: new Date("2026-01-02T11:15:00.000Z"),
        lastRequest: null,
        ownerLeft: false,
        user: { id: "user_fixture_03", name: "Diego Marino", email: "diego@acme.com" },
      },
      // Its creator was removed from the organization and their key was left behind - the case
      // the badge exists for, since nothing else on this screen would distinguish it.
      {
        id: "key_fixture_04",
        name: "Nightly export",
        start: "ask_2d8",
        createdAt: new Date("2025-11-18T08:00:00.000Z"),
        lastRequest: USED_TODAY,
        ownerLeft: true,
        user: { id: "user_fixture_04", name: "Mika Toivonen", email: "mika@acme.com" },
      },
    ],
  },
};

// A page story, not a component story: the panel reads the signed-in user through
// `useAuth`, which resolves `useRouteContext({ from: "__root__" })` and therefore needs
// the real route tree rather than the component shell's standalone router context.
const meta = {
  title: "Settings/ApiKeysPanel",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(apiKeyFixtures) },
  },
} satisfies Meta<typeof PageStory>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The list itself: each key names who created it and when it was last used. */
export const Default: Story = { args: { path: `/app/${baseApplication.slug}/settings/api-keys` } };

/**
 * Deleting a colleague's key. Anyone in the organization is allowed to, but the key acts
 * as its creator, so the dialog names them and says how recently it was used - the two
 * facts that decide whether this breaks something right now.
 */
export const DeleteColleaguesKey: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/api-keys` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /delete api key ci pipeline/i }));
  },
};

/** A colleague's key that has never been used - the safe case, and it says so. */
export const DeleteNeverUsedKey: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/api-keys` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /delete api key staging smoke tests/i }));
  },
};

/** Your own key: no warning, because there is no colleague to strand. */
export const DeleteOwnKey: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/api-keys` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /delete api key local development/i }));
  },
};

/**
 * A key whose creator was removed from the organization and whose key was kept. It still works,
 * which is exactly why the dialog says so rather than repeating the "may still be in use" copy.
 */
export const DeleteOrphanedKey: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/api-keys` },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /delete api key nightly export/i }));
  },
};
