import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { Suspense } from "react";
import { userEvent, within } from "storybook/test";
import { AgentConfiguringScreen } from "../routes/_blacklight/onboarding/-components/previewkit/agent-configuring-screen";

const CONNECTED_AT = new Date("2026-01-05T10:12:00.000Z");
// Relative, not fixed: the screen compares this against now to decide whether the
// agent looks stuck, so a hardcoded date is permanently stale and every story
// renders the stalled state. Nothing displays the value itself, so keeping it
// relative costs no screenshot determinism.
const LAST_ACTIVITY_AT = new Date(Date.now() - 30 * 1000);

/** The config the agent has written so far, exactly as the API would return it. */
const configDocument = previewConfigSchema.parse({
  version: 2,
  apps: [
    {
      name: "web",
      repository: "acme/storefront",
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
      // Without this the screen renders its "no path chosen yet" branch, which is
      // not the state a previewkit_configuring app is ever actually in.
      previewEnvironmentMode: "previewkit",
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
      repos: [{ repo: "acme/storefront", primary: true }],
    },
  },
};

/**
 * The configuring fixtures with the preview path swapped, so one fixture covers
 * all three states the screen now renders.
 */
function withPreviewPath(mode: "previewkit" | "existing_deploys" | undefined, vercelProject?: string): TrpcFixtures {
  const onboarding = configuringFixtures.onboarding ?? {};
  const session = onboarding.getAgentSession;
  const readiness = onboarding.getPreviewReadiness;
  return {
    ...configuringFixtures,
    onboarding: {
      ...onboarding,
      getAgentSession: session == null ? session : { ...session, previewEnvironmentMode: mode },
      // The integration cards infer the source from a linked Vercel project.
      listAvailableVercelProjects: {
        connected: vercelProject != null,
        projects: [],
        connectUrl: "https://vercel.com/integrations/autonoma/new",
        linkedProject: vercelProject == null ? undefined : { id: "prj_fixture_01", name: vercelProject },
      },
      // A path that is undecided, or one Autonoma does not build, is never
      // "building" - readiness sits idle until the customer's pipeline signals.
      getPreviewReadiness:
        readiness == null
          ? readiness
          : {
              ...readiness,
              mode,
              diagnostics:
                mode === "previewkit"
                  ? readiness.diagnostics
                  : { status: "idle", actions: [], logs: { available: false } },
              services: mode === "previewkit" ? readiness.services : [],
            },
    },
  };
}

/**
 * The agent is done: the preview is verified and the screen collapses to its
 * summary plus the one forward action. This is the hand-off out of previewkit -
 * Continue goes straight to Finish setup.
 */
function withReadyPreview(): TrpcFixtures {
  const onboarding = configuringFixtures.onboarding ?? {};
  const session = onboarding.getAgentSession;
  const readiness = onboarding.getPreviewReadiness;
  return {
    ...configuringFixtures,
    onboarding: {
      ...onboarding,
      getAgentSession:
        session == null
          ? session
          : {
              ...session,
              step: "preview_verified",
              previewVerificationStatus: "ready",
              logs: session.logs.map((entry) =>
                entry.status === "running"
                  ? { ...entry, status: "done", message: "Deployed the preview off main" }
                  : entry,
              ),
            },
      getPreviewReadiness:
        readiness == null
          ? readiness
          : {
              ...readiness,
              diagnostics: {
                status: "ready",
                actions: [],
                logs: { available: true, repoFullName: "acme/storefront", prNumber: 0 },
              },
              services: [
                { name: "web", status: "ready" },
                { name: "db", status: "ready" },
              ],
            },
    },
  };
}

/** The same session with its last activity pushed well past the stalled threshold. */
function withStalledHeartbeat(): TrpcFixtures {
  const fixtures = withPreviewPath("existing_deploys");
  const onboarding = fixtures.onboarding ?? {};
  const session = onboarding.getAgentSession;
  return {
    ...fixtures,
    onboarding: {
      ...onboarding,
      getAgentSession:
        session == null ? session : { ...session, agentLastActivityAt: new Date(Date.now() - 12 * 60 * 1000) },
    },
  };
}

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

/**
 * No preview path chosen yet - the agent is still reading the repo to decide.
 * The headline must not promise a preview, and there is no topology or deploy to
 * show because neither exists until the path is picked.
 */
export const DecidingPath: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(withPreviewPath(undefined)),
    },
  },
};

/**
 * The customer's own pipeline builds the previews. Autonoma has no build to
 * watch, so the deploy panel becomes the signal state and the preview topology
 * is gone entirely.
 */
export const OwnPipeline: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(withPreviewPath("existing_deploys")),
    },
  },
};

/** The same path with a linked Vercel project, which is how the source is inferred. */
export const OwnPipelineVercel: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(withPreviewPath("existing_deploys", "acme-web")),
    },
  },
};

/**
 * The end of the agent-driven preview flow: the preview is verified and Continue
 * is the only thing left to press. It lands on Finish setup, not the app home.
 */
export const PreviewReady: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(withReadyPreview()),
    },
  },
};

/**
 * The agent's heartbeat has gone quiet. The server does not release control for
 * 30 minutes, so without this the user watches a spinner the whole time with no
 * idea the agent is waiting on THEM - in a terminal it cannot see this screen from.
 */
export const AgentStalled: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(withStalledHeartbeat()),
    },
  },
};
