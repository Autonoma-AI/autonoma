import type { Meta, StoryObj } from "@storybook/react-vite";
import { trpcHandler, type TrpcFixtures } from "lib/storybook/trpc-handler";
import { PreviewEnvironmentPage } from "../routes/_blacklight/onboarding/preview-environment";

const APP_ID = "app_fixture_01";
const FIXTURE_EPOCH = "2026-01-01T00:00:00.000Z";

/**
 * Nobody has paired yet, so the step shows the coding-agent headline with the
 * questionnaire demoted to an opt-out.
 */
function unpairedFixtures(): TrpcFixtures {
  return {
    onboarding: {
      createAgentPairing: { code: "EKQGGK85", expiresAt: new Date(FIXTURE_EPOCH) },
      getAgentSession: {
        applicationId: APP_ID,
        step: "preview_environment",
        previewVerificationStatus: "idle",
        holder: "human",
        effectiveHolder: "human",
        stale: false,
        logs: [],
      },
    },
  };
}

const meta = {
  title: "Onboarding/PreviewEnvironmentStep",
  component: PreviewEnvironmentPage,
  parameters: { layout: "padded" },
} satisfies Meta<typeof PreviewEnvironmentPage>;

export default meta;

type Story = StoryObj<typeof meta>;

/**
 * The headline: hand the pairing code to a coding agent and it reads the repo,
 * picks the path itself, and does the work.
 */
export const AgentFirst: Story = {
  args: { appId: APP_ID },
  parameters: { msw: { handlers: [trpcHandler(unpairedFixtures())] } },
};

/** The opt-out (`?manual`) - the routing questionnaire, unchanged. */
export const AnswerQuestionsInstead: Story = {
  args: { appId: APP_ID, manual: true },
  parameters: { msw: { handlers: [trpcHandler(unpairedFixtures())] } },
};
