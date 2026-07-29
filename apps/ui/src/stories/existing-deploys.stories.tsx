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
 * The mid-build state: the redeploy returned a new deployment id and the
 * readiness poll keeps answering BUILDING, so the page stays in the wait state
 * the story is here to show.
 */
function buildingFixtures(): TrpcFixtures {
  return {
    onboarding: {
      listAvailableVercelProjects: linkedProjects,
      listVercelDeployments: deployments,
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
  parameters: { msw: { handlers: [trpcHandler(buildingFixtures())] } },
};

/**
 * Picks a deployment and starts the redeploy, leaving the page in the build wait
 * state: the loader under the picker plus the "building preview" preview-status
 * badge.
 */
export const BuildingPreview: Story = {
  args: { appId: APP_ID, initialProvider: "vercel" },
  parameters: { msw: { handlers: [trpcHandler(buildingFixtures())] } },
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
