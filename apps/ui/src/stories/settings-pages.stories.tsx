import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { dashboardFixtures } from "./app-home.stories";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const ORG_ID = "org_fixture_01";
const SDK_ENDPOINT = "https://app.acme.example.com/api/autonoma";

/**
 * The application whose SDK endpoint is configured. `baseApplication` ships with `webhookUrl: null`, which is
 * the honest default for a new app but renders the Scenarios & SDK destination as its empty state.
 */
const appWithSdkEndpoint: typeof baseApplication = {
  ...baseApplication,
  mainBranch: {
    ...baseApplication.mainBranch,
    deployment:
      baseApplication.mainBranch.deployment == null
        ? null
        : { ...baseApplication.mainBranch.deployment, webhookUrl: SDK_ENDPOINT },
  },
};

/** The repository General now shows, since the linked repository moved out of the deleted GitHub tab. */
const generalFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getApplicationRepository: {
      id: 123456,
      name: "checkout-web",
      fullName: "acme/checkout-web",
      defaultBranch: "main",
      private: true,
    },
  },
};

const scenarioFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  applications: { list: [appWithSdkEndpoint] },
  scenarios: {
    list: [
      {
        id: "scn_checkout_guest",
        applicationId: baseApplication.id,
        organizationId: ORG_ID,
        name: "checkout-as-guest",
        description: "A guest cart with two line items, ready to pay",
        activeRecipeVersionId: "rcp_checkout_v3",
        lastSeenFingerprint: "b41c09f",
        lastDiscoveredAt: new Date("2026-07-27T15:42:00Z"),
        fingerprintChangedAt: null,
        isDisabled: false,
        createdAt: FIXTURE_EPOCH,
        updatedAt: FIXTURE_EPOCH,
      },
      {
        id: "scn_admin_refund",
        applicationId: baseApplication.id,
        organizationId: ORG_ID,
        name: "admin-refund",
        description: "A settled order an admin can refund",
        activeRecipeVersionId: null,
        lastSeenFingerprint: "77ae2d1",
        lastDiscoveredAt: new Date("2026-07-27T15:42:00Z"),
        fingerprintChangedAt: new Date("2026-07-20T09:10:00Z"),
        isDisabled: false,
        createdAt: FIXTURE_EPOCH,
        updatedAt: FIXTURE_EPOCH,
      },
    ],
    listWebhookCalls: [],
  },
};

const orgGithubFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getInstallation: {
      id: "ghi_fixture_01",
      installationId: 1,
      organizationId: ORG_ID,
      accountLogin: "acme",
      accountId: 42,
      accountType: "Organization",
      status: "active",
      appSlug: "autonoma-ai",
      settingsUrl: "https://github.com/organizations/acme/settings/installations/1",
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
    },
  },
};

const meta = {
  title: "Pages/Settings",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(generalFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * General, and the section rail that replaced the eight-tab bar. Each entry carries a one-line description,
 * which is the whole point of the rail: the tab bar could only ever show a word.
 */
export const General: Story = {
  args: { path: `/app/${baseApplication.slug}/settings` },
};

/** The same rail at a width where the old eight-tab bar clipped two entries off screen with no affordance. */
export const GeneralNarrow: Story = {
  args: { path: `/app/${baseApplication.slug}/settings` },
  globals: { viewport: { value: "tablet", isRotated: false } },
};

/**
 * Scenarios & SDK: the endpoint Autonoma calls reads as configuration at the top, and what came back from it
 * sits below. Previously the endpoint was a strip buried inside the tool it gates.
 */
export const ScenariosAndSdk: Story = {
  parameters: { msw: { handlers: appShellHandlers(scenarioFixtures) } },
  args: { path: `/app/${baseApplication.slug}/settings/scenarios` },
};

/** No endpoint configured: everything below it is empty by definition, so the page is the one call to action. */
export const ScenariosAndSdkUnconfigured: Story = {
  parameters: {
    msw: {
      handlers: appShellHandlers({ ...generalFixtures, scenarios: { list: [], listWebhookCalls: [] } }),
    },
  },
  args: { path: `/app/${baseApplication.slug}/settings/scenarios` },
};

/**
 * Billing, in the same rail as everything else. It is organization state reached through an application's
 * URL, so the rail groups it under the organization's name and the destination itself opens by saying the
 * credits are shared - the two places a reader could notice before changing something.
 */
export const OrgBilling: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/billing` },
};

/** The GitHub App installation, split from the per-application repository row that now lives in General. */
export const OrgGithub: Story = {
  parameters: { msw: { handlers: appShellHandlers(orgGithubFixtures) } },
  args: { path: `/app/${baseApplication.slug}/settings/github` },
};
