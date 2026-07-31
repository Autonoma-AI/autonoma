import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

/**
 * The first onboarding step before any GitHub App exists: the install CTA paired with
 * the "View demo" escape hatch for someone who wants to see the product before wiring
 * their own repositories into it.
 */
const installFixtures: TrpcFixtures = {
  github: {
    getInstallation: null,
    listRepositories: [],
    getConfig: { installUrl: "https://github.com/apps/autonoma-ai/installations/new" },
  },
  applications: { list: [] },
};

/**
 * The GitHub App is installed but was granted access to no repository, so there is
 * nothing to pick: the copy explains what to grant and the CTA sends the visitor back
 * to the App's configuration page.
 */
const noRepoAccessFixtures: TrpcFixtures = {
  github: {
    getInstallation: {
      id: "ghi_01hzq7m4k2",
      installationId: 84213907,
      organizationId: "org_acme",
      accountLogin: "acme-inc",
      accountId: 5821094,
      accountType: "Organization",
      status: "active",
      createdAt: new Date("2026-07-14T09:12:00Z"),
      updatedAt: new Date("2026-07-14T09:12:00Z"),
      settingsUrl: "https://github.com/apps/autonoma-ai/installations/new",
      appSlug: "autonoma-ai",
    },
    listRepositories: [],
    getConfig: { installUrl: "https://github.com/apps/autonoma-ai/installations/new" },
  },
  applications: { list: [] },
};

const meta = {
  title: "Pages/OnboardingAddApp",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(installFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Install: Story = {
  args: { path: "/onboarding" },
};

export const NoRepositoryAccess: Story = {
  args: { path: "/onboarding" },
  parameters: { msw: { handlers: appShellHandlers(noRepoAccessFixtures) } },
};
