import type { Meta, StoryObj } from "@storybook/react-vite";
import { AGENT_DIALOG_DESCRIPTION, ConnectAgentDialog, MCP_SERVER_NAME } from "components/connect-agent-dialog";
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
 * The one connect-agent dialog, which every surface hands off to. There is a single server
 * and a single installation, so what varies between callers is the instruction the agent is
 * started on and whether an application is pinned with a pairing code.
 */
const meta = {
  title: "Components/ConnectAgentDialog",
  component: ConnectAgentDialog,
  parameters: { msw: { handlers: appShellHandlers({ onboarding: { createAgentPairing: pairing } }) } },
  args: {
    open: true,
    onOpenChange: () => undefined,
    applicationId: baseApplication.id,
    title: "Debug with a coding agent",
    description: AGENT_DIALOG_DESCRIPTION,
  },
} satisfies Meta<typeof ConnectAgentDialog>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The SDK step's dialog: validate the environment factory against a preview and fix it. */
export const SdkStep: Story = {
  args: {
    instruction: AGENT_INSTRUCTIONS.sdk,
    capabilities: (
      <>
        <NameTheMcpNote /> From your repo it validates the endpoint against a preview, reads that preview's runtime
        logs, and fixes the handler.
      </>
    ),
  },
};

/** The dry-run step's dialog: same server, same pairing, a different ask. */
export const DryRunStep: Story = {
  args: {
    instruction: AGENT_INSTRUCTIONS.dryRun,
    capabilities: (
      <>
        <NameTheMcpNote /> It can read the recipe, try edits against your deployed SDK without saving them, and fix the
        SDK handler in your repo.
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

/**
 * The same dialog without an application to pin: the debugging job, where the agent
 * identifies the app from the repo it is already sitting in, so there is no pairing code
 * and no code minted. Everything below the header is identical.
 */
export const NoPairing: Story = {
  args: {
    applicationId: undefined,
    title: "Fix with a coding agent",
    description:
      "Install the Autonoma MCP in your coding agent. It picks up the repo from your local git and connects automatically - no pairing code to paste.",
    instruction: `use the ${MCP_SERVER_NAME} MCP to tell me why my preview failed`,
    capabilities: (
      <>
        <NameTheMcpNote /> It reads the repo and PR from your local git.
      </>
    ),
  },
};
