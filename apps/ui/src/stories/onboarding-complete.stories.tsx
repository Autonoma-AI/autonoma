import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseApplication } from "lib/storybook/base-fixtures";
import { trpcHandler } from "lib/storybook/trpc-handler";
import { CompletePage } from "../routes/_blacklight/onboarding/complete";

/**
 * The last previewkit step: the app is live on pull requests, and the hand-off is
 * straight into Finish setup - the SDK, artifacts and dry-run work that has to
 * happen before Autonoma can provision test data.
 */
const meta = {
  title: "Onboarding/Complete",
  component: CompletePage,
  parameters: {
    layout: "padded",
    msw: { handlers: [trpcHandler({ applications: { list: [baseApplication] } })] },
  },
} satisfies Meta<typeof CompletePage>;

export default meta;

type Story = StoryObj<typeof meta>;

export const LiveHandoff: Story = {
  args: { appId: baseApplication.id },
};
