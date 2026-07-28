import type { Meta, StoryObj } from "@storybook/react-vite";
import { ONBOARDING_MCP_SERVER_NAME } from "components/connect-agent-dialog";
import {
  ConnectOnboardingAgentDialog,
  ONBOARDING_AGENT_DIALOG_DESCRIPTION,
} from "components/connect-onboarding-agent-dialog";
import { NameTheMcpNote } from "components/name-the-mcp-note";
import { FINISH_SETUP_AGENT_INSTRUCTIONS } from "lib/onboarding/finish-setup-agent-instructions";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import type { RouterOutputs } from "lib/trpc";

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
    instruction: FINISH_SETUP_AGENT_INSTRUCTIONS.sdk,
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
    instruction: FINISH_SETUP_AGENT_INSTRUCTIONS.dryRun,
    capabilities: (
      <>
        <NameTheMcpNote serverName={ONBOARDING_MCP_SERVER_NAME} /> It can read the recipe, try edits against your
        deployed SDK without saving them, and fix the SDK handler in your repo.
      </>
    ),
  },
};
