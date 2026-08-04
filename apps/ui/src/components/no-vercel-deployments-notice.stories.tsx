import type { Meta, StoryObj } from "@storybook/react-vite";
import { NoVercelDeploymentsNotice } from "components/no-vercel-deployments-notice";

const meta = {
  title: "Components/NoVercelDeploymentsNotice",
  component: NoVercelDeploymentsNotice,
  parameters: { layout: "padded" },
} satisfies Meta<typeof NoVercelDeploymentsNotice>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The linked project exists but has no READY build yet - the blocking case. */
export const NoDeployments: Story = {
  args: { projectName: "acme-web", isChecking: false, onCheckAgain: () => undefined },
};

/** Mid-retry (or mid-poll): the button holds the spinner and stays disabled. */
export const Checking: Story = {
  args: { projectName: "acme-web", isChecking: true, onCheckAgain: () => undefined },
};

/**
 * The deployments query itself failed - this used to render as the same benign
 * "none found yet" line, hiding the cause completely. The message is one the
 * backend really returns for a linked project whose Marketplace access token was
 * never stored or has been revoked: every deployment call fails, silently.
 */
export const LoadFailed: Story = {
  args: {
    projectName: "acme-web",
    errorMessage: "Vercel installation has no access token",
    isChecking: false,
    onCheckAgain: () => undefined,
  },
};
