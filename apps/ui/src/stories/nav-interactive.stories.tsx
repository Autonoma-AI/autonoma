import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { dashboardHandlers } from "lib/storybook/dashboard-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";
import { userEvent, within } from "storybook/test";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/**
 * The navigation, live.
 *
 * Everything here is the real component behind the real route tree, so the controls work: the application
 * switcher opens and lists the organization's applications, the account menu opens, and the tabs navigate for
 * real - click Tests and the page changes. The decision boards elsewhere use non-functional stand-ins because
 * they are about layout; this one is for finding out how the thing behaves.
 *
 * Three applications rather than one, because a switcher with a single entry cannot show what it is for.
 */

const SECOND_APP: RouterOutputs["applications"]["list"][number] = {
  ...baseApplication,
  id: "app_fixture_02",
  name: "Acme Payments",
  slug: "acme-payments",
};

const THIRD_APP: RouterOutputs["applications"]["list"][number] = {
  ...baseApplication,
  id: "app_fixture_03",
  name: "Acme Admin Console",
  slug: "acme-admin-console",
};

const PATH = `/app/${baseApplication.slug}/pull-requests`;
const EPOCH = new Date("2026-01-01T00:00:00.000Z");

/**
 * How long the first `findBy*` of a `play` waits for the bar to exist.
 *
 * These stories mount the real route tree, so the shell's gate resolves the session, the organization and the
 * application list before any of the bar renders - until then the loading silhouette is on screen, and it has no
 * switcher, no meter and no account trigger to find. testing-library waits one second by default, which is
 * shorter than that gate, so every one of these plays raced it: the query threw, the interaction never happened,
 * and `storybook:shoot` photographed a closed menu and reported a success.
 */
const SHELL_READY = { timeout: 15_000 };

/** No subscription, so the Upgrade call to action renders. Everything else matches the baseline fixture. */
const UNSUBSCRIBED: RouterOutputs["billing"]["status"] = {
  creditBalance: 0,
  subscriptionCreditBalance: 0,
  topupCreditBalance: 0,
  provider: "stripe",
  subscriptionStatus: undefined,
  currentPeriodEnd: undefined,
  cancelAtPeriodEnd: false,
  gracePeriodEndsAt: undefined,
  autoTopUpEnabled: false,
  autoTopUpThreshold: 0,
  cliCreditsSpent: 0,
  transactions: [],
};

const TITLES = [
  "Export statements as CSV from the account page",
  "Round ledger balances half-up to match the bank",
  "Import bulk transfers from a signed CSV",
  "Consolidate the two external-transfer code paths",
  "Bump the all-dependencies group across 1 directory",
  "Rework the checkout submit flow",
];

/** Enough rows that the page reads as a page; the verdict states are storied properly in `Pages/PullRequests`. */
const ROWS = branchPage(
  TITLES.map((title, index) => ({
    id: `branch_nav_${index}`,
    name: `feat/nav-fixture-${index}`,
    createdAt: new Date(Date.UTC(2026, 6, 12, 8, 30)),
    prNumber: 4187 - index,
    pr: {
      title,
      state: "open" as const,
      authorLogin: "jrivera",
      updatedAt: new Date(Date.UTC(2026, 7, 3, 23 - index, 40)),
    },
    bugCount: 0,
    previewUrl: undefined,
    prStatus: { kind: "pending_checks" as const },
    activeSnapshot: null,
  })),
);

/** Two generating and one queued, so the chip has something to report and the count is not 1. */
const GENERATIONS: RouterOutputs["generations"]["list"] = [
  generation("01", "Checkout with a saved card", "running"),
  generation("02", "Invite a teammate by email", "running"),
  generation("03", "Export statements as CSV", "queued"),
  generation("04", "Sign in with a valid password", "success"),
];

function generation(
  suffix: string,
  testName: string,
  status: RouterOutputs["generations"]["list"][number]["status"],
): RouterOutputs["generations"]["list"][number] {
  return {
    id: `gen_fixture_${suffix}`,
    shortId: `gen-${suffix}`,
    testName,
    tags: [],
    stepCount: 6,
    status,
    createdAt: EPOCH,
  };
}

const FIXTURES: Parameters<typeof dashboardHandlers>[0] = {
  applications: { list: [baseApplication, SECOND_APP, THIRD_APP] },
  branches: { list: ROWS },
  generations: { list: GENERATIONS },
};

const handlers = dashboardHandlers(FIXTURES);

/**
 * Everything the bar can show, at once: an internal admin and an organization that has not paid, so the third
 * tab and the Upgrade call to action are both on screen. No real reader sees both simultaneously - it is the
 * worst case for width, and the point is that every control is on screen and clickable.
 *
 * Onboarding stays complete, and it has to: `app.$appSlug/route.tsx` redirects an application that has not
 * finished setup into the onboarding flow, so an unfinished fixture here photographs that flow rather than
 * this bar.
 */
const everythingHandlers = dashboardHandlers({ ...FIXTURES, billing: { status: UNSUBSCRIBED } }, { role: "admin" });

const meta = {
  title: "Nav/Interactive",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen", msw: { handlers } },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Everything on, everything clickable: the switcher (three applications), the tabs including an admin's third
 * one, Upgrade, and the account menu.
 */
export const Default: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: everythingHandlers } },
};

/** The same bar as a paying, set-up customer actually sees it - which is most of the time. */
export const Steady: Story = {
  args: { path: PATH },
};

/**
 * The application switcher, opened by clicking it rather than rendered open, so what is photographed is a menu a
 * reader could actually have got to.
 *
 * Note what this does NOT do: `storybook:shoot` exits non-zero only for unmocked tRPC procedures, so a `play`
 * that throws - a trigger that stopped working, a label that was renamed - is screenshotted as a closed menu and
 * reported as a success. Read the PNG. It would fail properly under Storybook's interactions test runner, which
 * we do not run.
 */
export const AppSwitcherOpen: Story = {
  args: { path: PATH },
  play: async ({ canvasElement }) => {
    const trigger = await within(canvasElement).findByLabelText(/switch application/i, undefined, SHELL_READY);
    await userEvent.click(trigger);
    // The menu renders in a portal, so it is outside `canvasElement`.
    await within(document.body).findByText("Add app");
  },
};

/** The account menu, opened - the receipt that everything relocated out of the rail has a home in here. */
export const AccountMenuOpen: Story = {
  args: { path: PATH },
  play: async ({ canvasElement }) => {
    const trigger = await within(canvasElement).findByLabelText(/^account:/i, undefined, SHELL_READY);
    await userEvent.click(trigger);
    await within(document.body).findByText("Credits and billing");
  },
};

/**
 * The organization switcher, for a reader who belongs to more than one.
 *
 * The rail used to carry this and the top bar dropped it, which left a multi-organization member with no way
 * to change organization anywhere in the chrome. It is a dropdown rendered inside the account menu's own
 * dropdown, so this story exists to prove that nesting actually opens rather than closing its parent.
 */
export const OrgSwitcherOpen: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: dashboardHandlers({
        organization: {
          mine: [
            {
              id: "org_fixture_01",
              name: "Acme",
              slug: "acme",
              isActive: true,
              memberCount: 4,
              applicationCount: 3,
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
          ],
        },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const trigger = await within(canvasElement).findByLabelText(/^account:/i, undefined, SHELL_READY);
    await userEvent.click(trigger);
    // By role, not by text: the bar renders "Acme /" as well, and an ambiguous `findByText` throws - which a
    // `play` does silently, leaving a screenshot of an unopened menu that still reports success.
    const orgTrigger = await within(document.body).findByRole("button", { name: "Acme" });
    await userEvent.click(orgTrigger);
    await within(document.body).findByText("Northwind");
  },
};

/** The suite-health panel, opened by hovering the meter the way a reader would. */
export const SuiteHealthOpen: Story = {
  args: { path: PATH },
  play: async ({ canvasElement }) => {
    const meter = await within(canvasElement).findByLabelText("Suite health", undefined, SHELL_READY);
    await userEvent.hover(meter);
    await within(document.body).findByText(/raises it/i);
  },
};

/**
 * The account menu for an internal admin, which is the only way to see the Admin group.
 *
 * Between them, this and the bar behind it carry what the rail's admin entries carried: "App admin" is a tab,
 * beside the sections it belongs with, and the console-or-back-to-apps pair is in here. Both are gated on
 * `isAdmin` exactly as the rail gated them, so the ordinary account menu above is not missing them - it is a
 * customer's menu, and never had them.
 */
export const AccountMenuAsAdmin: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: everythingHandlers } },
  play: async ({ canvasElement }) => {
    const trigger = await within(canvasElement).findByLabelText(/^account:/i, undefined, SHELL_READY);
    await userEvent.click(trigger);
    // "Admin console" rather than "App admin": the latter is a tab in the bar now, so it is on screen whether
    // or not the menu opened, and asserting it would pass against a trigger that had stopped working.
    await within(document.body).findByText("Admin console");
  },
};
