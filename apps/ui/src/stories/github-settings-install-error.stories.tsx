import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { dashboardFixtures } from "./app-home.stories";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/**
 * A workspace already connected to the GitHub account `acme`, with one repository linked to the
 * app. This is the state that makes the install conflict reachable: connecting a SECOND account is
 * refused precisely because this one is already resolving every GitHub read.
 */
const connectedInstallation = {
  id: "ghi_fixture_01",
  installationId: 62819043,
  organizationId: "org_fixture_01",
  accountLogin: "acme",
  accountId: 4820193,
  accountType: "Organization",
  status: "active",
  createdAt: FIXTURE_EPOCH,
  updatedAt: FIXTURE_EPOCH,
  settingsUrl: "https://github.com/organizations/acme/settings/installations/62819043",
  appSlug: "autonoma",
} as const;

const INSTALL_URL = "https://github.com/apps/autonoma/installations/new?state=fixture-state";

const connectedFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    // The install screen asks for a signed install link rather than telling the user to navigate
    // somewhere - see the `OnboardingUnattributed` story below.
    getConfig: { installUrl: INSTALL_URL },
    getInstallation: connectedInstallation,
    listRepositories: {
      repos: [
        {
          id: 123456,
          name: "acme-web",
          fullName: "acme/acme-web",
          defaultBranch: "main",
          private: true,
          applicationId: baseApplication.id,
          applicationName: baseApplication.name,
        },
        {
          id: 123457,
          name: "acme-api",
          fullName: "acme/acme-api",
          defaultBranch: "main",
          private: true,
          applicationId: undefined,
          applicationName: undefined,
        },
      ],
    },
  },
};

const meta = {
  title: "Pages/GitHubSettings",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(connectedFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const CONFLICT_SEARCH = new URLSearchParams({
  error: "account_already_connected",
  account: "acme",
  attempted: "acme-labs",
  manageUrl: "https://github.com/settings/installations/71930554",
}).toString();

/** The connected state, with the one-account limit stated before anyone trips over it. */
export const Connected: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/github` },
};

/**
 * The GitHub account is connected to a DIFFERENT Autonoma workspace - typically an earlier trial
 * at the same company, under someone else's email. The way out runs entirely through GitHub, so it
 * does not depend on having access to that workspace.
 */
export const AccountClaimedElsewhere: Story = {
  args: {
    path: `/app/${baseApplication.slug}/settings/github?${new URLSearchParams({
      error: "account_claimed_elsewhere",
      attempted: "acme-labs",
      manageUrl: "https://github.com/settings/installations/71930554",
    }).toString()}`,
  },
};

/**
 * What the install callback now redirects to when someone installs Autonoma on a second GitHub
 * account. Previously this route had no `validateSearch` at all, so the same redirect rendered an
 * unchanged settings page and the user was told nothing.
 */
export const SecondAccountRefused: Story = {
  args: { path: `/app/${baseApplication.slug}/settings/github?${CONFLICT_SEARCH}` },
};

/**
 * The onboarding install screen carrying a failure, which is where every install that has no
 * return path now lands. Nothing is connected yet, so the fixtures drop the installation - this is
 * the state a brand-new signup is in when an install started on GitHub bounces back.
 */
const notConnectedFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getConfig: { installUrl: "https://github.com/apps/autonoma/installations/new?state=fixture-state" },
    getInstallation: null,
    listRepositories: { repos: [] },
  },
};

export const OnboardingUnattributed: Story = {
  parameters: { msw: { handlers: appShellHandlers(notConnectedFixtures) } },
  args: { path: "/onboarding/add-app?error=unattributed" },
};

/** Same screen, but the failure is a conflict - so the Install button is disabled until it is resolved. */
export const OnboardingSecondAccountRefused: Story = {
  parameters: { msw: { handlers: appShellHandlers(notConnectedFixtures) } },
  args: {
    path: `/onboarding/add-app?${new URLSearchParams({
      error: "account_already_connected",
      account: "acme",
      attempted: "acme-labs",
      manageUrl: "https://github.com/settings/installations/62819043",
    }).toString()}`,
  },
};

/**
 * The install was completed on GitHub, but nobody came back to Autonoma within the window that
 * lets a callback bind it. Installing again does not help on its own - GitHub keeps the same
 * installation - so the steps say to uninstall and reinstall, which is the only path that ends.
 */
export const OnboardingStaleInstallation: Story = {
  parameters: { msw: { handlers: appShellHandlers(notConnectedFixtures) } },
  args: { path: "/onboarding/add-app?error=stale_installation" },
};

/**
 * Nothing connected - after an uninstall, or before a first install. The API reports a `deleted`
 * installation as absent, so this is what someone who just uninstalled on GitHub now sees, instead
 * of a Configure button pointing at an installation GitHub has forgotten.
 */
export const OnboardingNothingConnected: Story = {
  parameters: { msw: { handlers: appShellHandlers(notConnectedFixtures) } },
  args: { path: "/onboarding/add-app" },
};

/**
 * Connected, but the installation can see no repositories. The action is granting it access - on
 * its own GitHub page, never the account picker, which is how the second-account conflict got
 * triggered by the button meant to fix a missing repository.
 */
const noReposFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getConfig: { installUrl: INSTALL_URL },
    getInstallation: connectedInstallation,
    listRepositories: { repos: [] },
  },
};

export const OnboardingNoRepositories: Story = {
  parameters: { msw: { handlers: appShellHandlers(noReposFixtures) } },
  args: { path: "/onboarding/add-app" },
};

/**
 * GitHub suspended the installation. It still exists, so its page is a real destination and the
 * only one that can lift the suspension - reinstalling would not.
 */
const suspendedFixtures: TrpcFixtures = {
  ...dashboardFixtures,
  github: {
    getConfig: { installUrl: INSTALL_URL },
    getInstallation: { ...connectedInstallation, status: "suspended" },
    listRepositories: { repos: [], unavailable: "GitHub suspended this installation." },
  },
};

export const OnboardingSuspended: Story = {
  parameters: { msw: { handlers: appShellHandlers(suspendedFixtures) } },
  args: { path: "/onboarding/add-app" },
};
