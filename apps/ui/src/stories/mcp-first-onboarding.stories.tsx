import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";
import { ConnectionCube } from "../routes/_blacklight/onboarding/-components/previewkit/mcp-first-config-view";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** Onboarding paused on the config-previews step, config not yet claimed by an agent. */
function makeConfiguringState(): RouterOutputs["onboarding"]["getState"] {
  return {
    id: "onboarding_fixture_mcp",
    applicationId: baseApplication.id,
    step: "previewkit_configuring",
    agentConnectedAt: null,
    agentLogs: [],
    productionUrl: "https://app.acme.example.com",
    previewEnvironmentMode: "previewkit",
    previewUrl: null,
    previewVerificationStatus: "idle",
    previewDeployRequestedAt: null,
    completedAt: null,
    lastDiscoveryError: null,
    lastDiscoveredAt: null,
    lastDiscoveredModels: null,
    discoveringStartedAt: null,
    dryRunPassedAt: null,
    diffTriggerConfirmedAt: null,
    agentHolder: "human",
    agentLastActivityAt: null,
    agentPendingRequest: null,
    agentPairingCode: null,
    agentPairingExpiresAt: null,
    agentClient: null,
    createdAt: FIXTURE_EPOCH,
    updatedAt: FIXTURE_EPOCH,
    sdkConfigured: false,
    dryRunPassed: false,
    discoveryInProgress: false,
    artifactsUploaded: false,
    hasContent: false,
    setupComplete: false,
  };
}

/** The agent hasn't paired yet, so the human holds the config and the MCP-first headline shows. */
const waitingSession: RouterOutputs["onboarding"]["getAgentSession"] = {
  applicationId: baseApplication.id,
  step: "previewkit_configuring",
  previewVerificationStatus: "idle",
  holder: "human",
  effectiveHolder: "human",
  stale: false,
  logs: [],
};

const waitingFixtures: TrpcFixtures = {
  onboarding: {
    getState: makeConfiguringState(),
    getAgentSession: waitingSession,
  },
  applications: {
    list: [baseApplication],
    // Deliberately placeholder-shaped, not credential-shaped: this story is the source
    // of a published screenshot, and a realistic token there teaches readers that
    // pasting real ones into screenshots is fine.
    getSharedSecret: { sharedSecret: "your_shared_secret_here" },
  },
  applicationSetups: {
    // Only the setup id is fetched on render now - the token is minted on copy, so a
    // story that merely renders the screen never needs one.
    resolveCliSetup: { setupId: "your_generation_id_here" },
  },
};

/**
 * The full config-previews onboarding step: ONE planner command on the left - the whole
 * of setup, credentials masked on screen and real only in the clipboard - the idle gray
 * "Waiting to pair" cube on the right, and the demoted "Configure manually" link.
 */
const meta = {
  title: "Onboarding/McpFirstConfig",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Waiting: Story = {
  args: { path: `/onboarding?step=previewkit-config&appId=${baseApplication.id}` },
  parameters: { msw: { handlers: appShellHandlers(waitingFixtures) } },
};

/**
 * The same step reached from `preview-environment` - the route a first-time user
 * actually lands on. It renders the identical view but, unlike `previewkit-config`,
 * has no Suspense boundary of its own, which is why the command block carries one.
 */
export const WaitingFromPreviewEnvironment: Story = {
  args: { path: `/onboarding?step=preview-environment&appId=${baseApplication.id}` },
  parameters: { msw: { handlers: appShellHandlers(waitingFixtures) } },
};

/**
 * The connect visual on its own: the lime, glowing "Connected - starting setup"
 * end-state the cube whips into once the agent pairs (a screenshot catches a single
 * frame of the spin-up). The idle gray state is visible in {@link Waiting}.
 */
export const ConnectedCube: StoryObj<typeof ConnectionCube> = {
  render: () => (
    <div className="blacklight flex min-h-dvh items-center justify-center bg-surface-void p-10">
      <div className="w-96 border border-primary">
        <ConnectionCube connected />
      </div>
    </div>
  ),
};
