import type { Meta, StoryObj } from "@storybook/react-vite";
import { ONBOARDING_MCP_SERVER_NAME } from "components/connect-agent-dialog";
import {
  ConnectOnboardingAgentDialog,
  ONBOARDING_AGENT_DIALOG_DESCRIPTION,
} from "components/connect-onboarding-agent-dialog";
import { NameTheMcpNote } from "components/name-the-mcp-note";
import { AGENT_INSTRUCTIONS } from "lib/onboarding/agent-instructions";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import type { RouterOutputs } from "lib/trpc";
import { userEvent, within } from "storybook/test";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

const pairing: RouterOutputs["onboarding"]["createAgentPairing"] = {
  code: "K7QM24",
  expiresAt: new Date(FIXTURE_EPOCH.getTime() + 10 * 60 * 1000),
};

/**
 * The connect-agent dialog every onboarding step hands off to. Both finish-setup steps
 * (SDK, dry run) render it with their own instruction, so the prompt the user copies
 * always names `autonoma-onboarding` - the server they already installed.
 */
const meta = {
  title: "Components/ConnectOnboardingAgentDialog",
  component: ConnectOnboardingAgentDialog,
  parameters: { msw: { handlers: appShellHandlers({ onboarding: { createAgentPairing: pairing } }) } },
  args: {
    open: true,
    onOpenChange: () => undefined,
    applicationId: baseApplication.id,
    title: "Debug with a coding agent",
    description: ONBOARDING_AGENT_DIALOG_DESCRIPTION,
  },
} satisfies Meta<typeof ConnectOnboardingAgentDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The SDK step's dialog: validate the environment factory against a preview and fix it. */
export const SdkStep: Story = {
  args: {
    instruction: AGENT_INSTRUCTIONS.sdk(ONBOARDING_MCP_SERVER_NAME),
    capabilities: (
      <>
        <NameTheMcpNote serverName={ONBOARDING_MCP_SERVER_NAME} /> From your repo it validates the endpoint against a
        preview, reads that preview's runtime logs, and fixes the handler.
      </>
    ),
  },
};

/** The dry-run step's dialog: same server, same pairing, a different ask. */
export const DryRunStep: Story = {
  args: {
    instruction: AGENT_INSTRUCTIONS.dryRun(ONBOARDING_MCP_SERVER_NAME),
    capabilities: (
      <>
        <NameTheMcpNote serverName={ONBOARDING_MCP_SERVER_NAME} /> It can read the recipe, try edits against your
        deployed SDK without saving them, and fix the SDK handler in your repo.
      </>
    ),
  },
};

/**
 * The remote-agent tab: the one client that cannot complete OAuth, so the block carries a
 * credential instead. The key is masked here and on screen everywhere - it is created and
 * substituted only when the block is copied.
 */
export const RemoteAgent: Story = {
  args: SdkStep.args,
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await screen.findByRole("tab", { name: /remote agent/i }));
  },
};

/**
 * The remote-agent tab's hint, open. The label alone cannot say why a separate path exists,
 * and the answer is the list of agents that land on it.
 */
export const RemoteAgentTooltip: Story = { args: SdkStep.args };

/** The Codex tab, which reaches the remote server through the mcp-remote bridge. */
export const Codex: Story = {
  args: SdkStep.args,
  play: async ({ canvasElement }) => {
    const screen = within(canvasElement.ownerDocument.body);
    await userEvent.click(await screen.findByRole("tab", { name: /codex/i }));
  },
};
