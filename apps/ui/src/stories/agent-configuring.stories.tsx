import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { Suspense } from "react";
import { userEvent, within } from "storybook/test";
import { AgentConfiguringScreen } from "../routes/_blacklight/onboarding/-components/previewkit/agent-configuring-screen";

const CONNECTED_AT = new Date("2026-01-05T10:12:00.000Z");
const LAST_ACTIVITY_AT = new Date("2026-01-05T10:29:30.000Z");

/** The config the agent has written so far, exactly as the API would return it. */
const configDocument = previewConfigSchema.parse({
  version: 1,
  apps: [
    {
      name: "web",
      dockerfile: "Dockerfile",
      port: 3000,
      primary: true,
      health_check: "/login",
      build_secrets: ["STRIPE_SECRET_KEY"],
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
  ],
  services: [{ name: "db", recipe: "postgres", version: "16" }],
});

/**
 * The agent mid-configuration: it holds the config, has a few tool calls in the
 * activity stream, and the preview image is building. Shows the header with the
 * attention toggles (chime mute + browser-notification bell) next to Take over.
 */
const configuringFixtures: TrpcFixtures = {
  onboarding: {
    getAgentSession: {
      applicationId: baseApplication.id,
      step: "previewkit_configuring",
      previewVerificationStatus: "building",
      holder: "agent",
      effectiveHolder: "agent",
      stale: false,
      agentConnectedAt: CONNECTED_AT,
      agentLastActivityAt: LAST_ACTIVITY_AT,
      logs: [
        {
          id: "log_fixture_01",
          message: "Claimed the preview config for Acme Web",
          timestamp: "2026-01-05T10:12:00.000Z",
          tool: "pair",
          status: "done",
        },
        {
          id: "log_fixture_02",
          message: "Read the current preview config",
          timestamp: "2026-01-05T10:12:30.000Z",
          tool: "get_config",
          status: "done",
        },
        {
          id: "log_fixture_03",
          message: "Set up the web app on Node with a Postgres database",
          timestamp: "2026-01-05T10:14:05.000Z",
          tool: "apply_config",
          status: "done",
        },
        {
          id: "log_fixture_04",
          message: "Deploying the preview off main",
          timestamp: "2026-01-05T10:15:40.000Z",
          tool: "trigger_deploy",
          status: "running",
        },
      ],
      agentClient: "claude-code",
    },
    getPreviewReadiness: {
      mode: "previewkit",
      diagnostics: {
        status: "building",
        phase: "building-images",
        actions: [],
        logs: { available: false },
      },
      services: [
        { name: "web", status: "building" },
        { name: "db", status: "ready" },
      ],
    },
    getPreviewkitConfig: {
      applicationId: baseApplication.id,
      saved: true,
      document: configDocument,
      dependencyConfigs: [],
    },
  },
};

const meta = {
  title: "Onboarding/AgentConfiguringScreen",
  component: AgentConfiguringScreen,
  parameters: { msw: { handlers: appShellHandlers(configuringFixtures) } },
  decorators: [
    (Story) => (
      <Suspense fallback={undefined}>
        <div className="mx-auto max-w-5xl p-8">
          <Story />
        </div>
      </Suspense>
    ),
  ],
} satisfies Meta<typeof AgentConfiguringScreen>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Configuring: Story = { args: { applicationId: baseApplication.id } };

/** The "Notify me" menu open: sound + browser-notification checkboxes. */
export const NotifyMenuOpen: Story = {
  args: { applicationId: baseApplication.id },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = await canvas.findByRole("button", { name: /notify me/i });
    await userEvent.click(trigger);
  },
};
