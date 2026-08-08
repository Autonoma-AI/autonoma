import type { Meta, StoryObj } from "@storybook/react-vite";
import { trpcHandler, type TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";
import { userEvent, within } from "storybook/test";
import { ExistingDeploysPage } from "../routes/_blacklight/onboarding/existing-deploys";

const APP_ID = "app_fixture_01";
const FIXTURE_EPOCH = "2026-01-01T00:00:00.000Z";

const linkedProjects: RouterOutputs["onboarding"]["listAvailableVercelProjects"] = {
  connected: true,
  projects: [],
  connectUrl: "https://vercel.com/integrations/autonoma/new",
  linkedProject: { id: "prj_fixture_01", name: "acme-web" },
};

/** No project linked - what the Vercel tab looks like for someone on the custom path. */
const unlinkedProjects: RouterOutputs["onboarding"]["listAvailableVercelProjects"] = {
  connected: true,
  projects: [],
  connectUrl: "https://vercel.com/integrations/autonoma/new",
  linkedProject: undefined,
};

const deployments: RouterOutputs["onboarding"]["listVercelDeployments"] = [
  {
    id: "dpl_fixture_preview",
    url: "acme-web-git-feat-checkout.vercel.app",
    target: "preview",
    branch: "feat/checkout",
    createdAt: FIXTURE_EPOCH,
  },
  {
    id: "dpl_fixture_production",
    url: "acme-web.vercel.app",
    target: "production",
    branch: "main",
    createdAt: FIXTURE_EPOCH,
  },
];

/**
 * A linked Vercel project whose redeploy keeps answering BUILDING, so any story
 * that picks a deployment stays in the wait state. Pass `[]` for the blocked
 * case where the project has no READY deployment to pick in the first place.
 */
function vercelFixtures(readyDeployments = deployments): TrpcFixtures {
  return {
    onboarding: {
      listAvailableVercelProjects: linkedProjects,
      listVercelDeployments: readyDeployments,
      // No signal accepted yet - this is what used to make the preview-status
      // panel read "no deployment selected" while the build was running.
      getDeploymentSignalStatus: {},
      redeployVercelDeployment: {
        deploymentId: "dpl_fixture_redeployed",
        url: "acme-web-git-feat-checkout-abc123.vercel.app",
        readyState: "BUILDING",
      },
      getVercelDeploymentStatus: {
        readyState: "BUILDING",
        url: "acme-web-git-feat-checkout-abc123.vercel.app",
        ready: false,
      },
    },
    applications: { getSharedSecret: { sharedSecret: "your_shared_secret_here" } },
  };
}

/**
 * The custom (bring-your-own-deploys) path before anything has been wired up:
 * the setup guide is showing and no signed signal has arrived, so Continue is
 * locked.
 */
function customWaitingFixtures(): TrpcFixtures {
  return {
    onboarding: {
      // The page loads the Vercel projects regardless of the active tab.
      listAvailableVercelProjects: unlinkedProjects,
      getDeploymentSignalStatus: {},
      createAgentPairing: { code: "EKQGGK85", expiresAt: new Date(FIXTURE_EPOCH) },
    },
    applications: { getSharedSecret: { sharedSecret: "shs_fixture_0123456789abcdef" } },
    auth: {
      // The agent entry point checks whether this is the read-only demo org.
      activeOrg: {
        id: "org_fixture_01",
        name: "Acme",
        slug: "acme",
        isDemo: false,
        canReturnToAccount: false,
        mergeGateEnabled: false,
        vercelMarketplaceEntry: false,
        invitesEnabled: true,
        needsNaming: false,
      },
    },
  };
}

/** The same path once CI has POSTed a valid signed payload - Continue unlocks. */
function customSignalReceivedFixtures(): TrpcFixtures {
  return {
    onboarding: {
      listAvailableVercelProjects: unlinkedProjects,
      getDeploymentSignalStatus: {
        previewUrl: "https://acme-web-git-feat-checkout.example.app",
        acceptedAt: FIXTURE_EPOCH,
      },
    },
    applications: { getSharedSecret: { sharedSecret: "shs_fixture_0123456789abcdef" } },
    auth: {
      // The agent entry point checks whether this is the read-only demo org.
      activeOrg: {
        id: "org_fixture_01",
        name: "Acme",
        slug: "acme",
        isDemo: false,
        canReturnToAccount: false,
        mergeGateEnabled: false,
        vercelMarketplaceEntry: false,
        invitesEnabled: true,
        needsNaming: false,
      },
    },
  };
}

const meta = {
  title: "Onboarding/ExistingDeploys",
  component: ExistingDeploysPage,
  parameters: { layout: "padded" },
} satisfies Meta<typeof ExistingDeploysPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/** A linked project with deployments to choose from, before anything is picked. */
export const DeploymentPicker: Story = {
  args: { appId: APP_ID, initialProvider: "vercel" },
  parameters: { msw: { handlers: [trpcHandler(vercelFixtures())] } },
};

/**
 * The linked project has no READY deployment, so the picker can't be shown at
 * all - the step is blocked until a build finishes, which is what the red notice
 * says (and why it carries the retry).
 */
export const NoReadyDeployments: Story = {
  args: { appId: APP_ID, initialProvider: "vercel" },
  parameters: { msw: { handlers: [trpcHandler(vercelFixtures([]))] } },
};

/**
 * The deployment list can't be read at all - a linked project whose Marketplace
 * token was revoked answers this way for every deployment call. The picker shows
 * the failure, and the gate below has to agree with it rather than tell the user
 * to pick from a list that isn't there.
 */
export const DeploymentsUnavailable: Story = {
  args: { appId: APP_ID, initialProvider: "vercel" },
  parameters: {
    msw: {
      handlers: [
        trpcHandler(vercelFixtures([]), {
          "onboarding.listVercelDeployments": "Vercel installation has no access token",
        }),
      ],
    },
  },
};

/**
 * Picks a deployment and starts the redeploy, leaving the page in the build wait
 * state: the loader under the picker plus the "building preview" preview-status
 * badge.
 */
export const BuildingPreview: Story = {
  args: { appId: APP_ID, initialProvider: "vercel" },
  parameters: { msw: { handlers: [trpcHandler(vercelFixtures())] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const picker = await canvas.findByRole("combobox", { name: /Select a deployment/ }, { timeout: 10_000 });
    await userEvent.click(picker);
    const option = await within(document.body).findByRole("option", { name: /feat\/checkout/ }, { timeout: 10_000 });
    await userEvent.click(option);
    await userEvent.click(await canvas.findByRole("button", { name: /Use this deployment/ }));
    await canvas.findByText(/Building your preview/, undefined, { timeout: 10_000 });
  },
};

/**
 * The custom path with nothing wired up yet: the flow diagram, the four ordered
 * setup steps, the workflow to commit, and the locked Continue button.
 */
export const CustomSetupGuide: Story = {
  args: { appId: APP_ID, initialProvider: "custom" },
  parameters: { msw: { handlers: [trpcHandler(customWaitingFixtures())] } },
};

/** The custom path after the first signed signal lands - Continue is enabled. */
export const CustomSignalReceived: Story = {
  args: { appId: APP_ID, initialProvider: "custom" },
  parameters: { msw: { handlers: [trpcHandler(customSignalReceivedFixtures())] } },
};

/**
 * The agent entry point opened: the install command per client, the pairing code,
 * and the prompt to hand over. This is the path where an agent is genuinely
 * better placed than the user - it can read how the project actually deploys.
 */
export const CustomAgentDialog: Story = {
  args: { appId: APP_ID, initialProvider: "custom" },
  parameters: { msw: { handlers: [trpcHandler(customWaitingFixtures())] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Wire it up with a coding agent/ }));
    await within(document.body).findByText(/Connect your deploys with a coding agent/, undefined, { timeout: 10_000 });
  },
};
