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
    createAgentPairing: { code: "EKQGGK85", expiresAt: new Date(FIXTURE_EPOCH.getTime() + 15 * 60 * 1000) },
  },
  applications: { list: [baseApplication] },
};

/**
 * The full config-previews onboarding step with the coding-agent (MCP) path as the
 * headline: pairing code + per-client install snippets on the left, the idle gray
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
