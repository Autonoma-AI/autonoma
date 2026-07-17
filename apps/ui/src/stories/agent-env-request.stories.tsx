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
 * The agent has raised an env request and is blocked on the user: the per-key
 * form renders one row per requested key with a value input, an "I don't have
 * this" skip toggle, and the shared paste-.env dialog to fill rows in bulk.
 */
const envRequestFixtures: TrpcFixtures = {
  onboarding: {
    getAgentSession: {
      applicationId: baseApplication.id,
      step: "previewkit_configuring",
      previewVerificationStatus: "idle",
      holder: "agent",
      effectiveHolder: "agent",
      stale: false,
      agentConnectedAt: CONNECTED_AT,
      agentLastActivityAt: LAST_ACTIVITY_AT,
      pendingRequest: {
        kind: "env",
        keys: ["STRIPE_SECRET_KEY", "RESEND_API_KEY", "OPENAI_API_KEY"],
        appName: "web",
        note: "Found these referenced in apps/web/.env.example - Stripe powers checkout, Resend sends the signup emails, and OpenAI backs the search summaries.",
      },
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
          message: "Set up the web app on Node with a Postgres database",
          timestamp: "2026-01-05T10:14:05.000Z",
          tool: "apply_config",
          status: "done",
        },
        {
          id: "log_fixture_03",
          message: "Requesting the Stripe, Resend and OpenAI keys",
          timestamp: "2026-01-05T10:15:40.000Z",
          tool: "request_env",
          status: "running",
        },
      ],
      agentClient: "claude-code",
    },
    getPreviewReadiness: {
      mode: "previewkit",
      diagnostics: {
        status: "idle",
        actions: [],
        logs: { available: false },
      },
      services: [],
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
  title: "Onboarding/AgentEnvRequest",
  component: AgentConfiguringScreen,
  parameters: { msw: { handlers: appShellHandlers(envRequestFixtures) } },
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

export const PendingEnvRequest: Story = { args: { applicationId: baseApplication.id } };

/**
 * Two keys filled, one left empty: the footer explains empty = "I don't have
 * it" and the submit button spells out the outcome ("Set 2 · skip 1").
 */
export const PartiallyFilled: Story = {
  args: { applicationId: baseApplication.id },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const stripe = await canvas.findByLabelText("Value for STRIPE_SECRET_KEY");
    await userEvent.type(stripe, "sk_live_51Mq8aFakeFixtureValue");
    const resend = await canvas.findByLabelText("Value for RESEND_API_KEY");
    await userEvent.type(resend, "re_8fJq2FakeFixtureValue");
  },
};

/**
 * The reveal eye toggled on: the typed value is shown in plaintext while the user
 * checks it before submitting. The other rows stay masked, per-key.
 */
export const RevealedValue: Story = {
  args: { applicationId: baseApplication.id },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const stripe = await canvas.findByLabelText("Value for STRIPE_SECRET_KEY");
    await userEvent.type(stripe, "sk_live_51Mq8aFakeFixtureValue");
    const reveal = await canvas.findByLabelText("Reveal value for STRIPE_SECRET_KEY");
    await userEvent.click(reveal);
  },
};
