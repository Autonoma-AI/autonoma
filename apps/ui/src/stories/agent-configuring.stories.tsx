import { previewConfigSchema } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { logStreamHandler, type LogStreamEvent } from "lib/storybook/log-stream-handler";
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
      build_secrets: ["STRIPE_SECRET_KEY"],
      connections: [{ key: "DATABASE_URL", value: "{{db.url}}" }],
    },
    {
      name: "api",
      repository: "acme/storefront",
      dockerfile: "api/Dockerfile",
      port: 4000,
      build_secrets: [],
      connections: [
        { key: "DATABASE_URL", value: "{{db.url}}" },
        { key: "REDIS_URL", value: "{{redis.url}}" },
      ],
    },
  ],
  services: [
    { name: "db", recipe: "postgres", version: "16" },
    { name: "redis", recipe: "redis", version: "7" },
  ],
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
        // An errored call belongs in the fixture: agents get things wrong, read the
        // error, and carry on - so the feed has to look calm when one does.
        {
          id: "log_fixture_04",
          message: "Pointed the api app at apps/api/Dockerfile",
          timestamp: "2026-01-05T10:14:50.000Z",
          tool: "apply_config",
          status: "error",
          error: "No Dockerfile at apps/api/Dockerfile",
        },
        {
          id: "log_fixture_05",
          message: "Pointed the api app at api/Dockerfile instead",
          timestamp: "2026-01-05T10:15:10.000Z",
          tool: "apply_config",
          status: "done",
        },
        {
          id: "log_fixture_06",
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
        { name: "web", kind: "app", status: "building", statusSource: "pipeline" },
        { name: "api", kind: "app", status: "building", statusSource: "pipeline" },
        { name: "db", kind: "managed", status: "building", statusSource: "pipeline" },
        { name: "redis", kind: "managed", status: "building", statusSource: "pipeline" },
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
 * The agent has verified the preview and the screen collapses to its summary. No
 * forward action: the agent takes the app live itself, and the screen resumes the
 * onboarding flow once the step moves - so what is rendered here is the wait for that.
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
                { name: "web", kind: "app", status: "ready", statusSource: "cluster" },
                { name: "api", kind: "app", status: "ready", statusSource: "cluster" },
                { name: "db", kind: "managed", status: "ready", statusSource: "cluster" },
                { name: "redis", kind: "managed", status: "ready", statusSource: "cluster" },
              ],
            },
    },
  };
}

const buildAt = (second: number) => new Date(CONNECTED_AT.getTime() + second * 1000);

/** Build output for a deploy that is past the image build and rolling the services out. */
const buildFrames: LogStreamEvent[] = [
  { event: "phase", data: { kind: "phase", message: "cloning repository" }, at: buildAt(0) },
  { event: "log", data: { kind: "log", message: "acme/storefront@a22387c extracted (412 files)" }, at: buildAt(2) },
  { event: "phase", data: { kind: "phase", message: "building images" }, at: buildAt(3) },
  { event: "log", data: { kind: "log", message: "#8 [5/9] RUN pnpm install --frozen-lockfile" }, at: buildAt(9) },
  { event: "log", data: { kind: "log", message: "#8 DONE 41.3s" }, at: buildAt(51) },
  {
    event: "log",
    data: { kind: "log", message: "#16 writing layer sha256:9899b563237de9f1d4ac5f86" },
    at: buildAt(58),
  },
  { event: "phase", data: { kind: "phase", message: "deploying-services" }, at: buildAt(60) },
];

/**
 * Runtime output from the pods rolling out. The screen follows the deploy onto the App
 * logs tab at this phase, so a story without these shows an empty panel that reads as
 * a broken stream rather than the state it is meant to document.
 */
const appFrames: LogStreamEvent[] = [
  {
    event: "log",
    data: { kind: "log", message: "db: database system is ready to accept connections" },
    at: buildAt(62),
  },
  { event: "log", data: { kind: "log", message: "redis: Ready to accept connections tcp" }, at: buildAt(63) },
  { event: "log", data: { kind: "log", message: "api: listening on port 4000" }, at: buildAt(66) },
  { event: "log", data: { kind: "log", message: "web: ready in 812ms" }, at: buildAt(68) },
];

/**
 * A deploy far enough along that its logs are streaming: the phase and status sit
 * together above the log tabs, rather than the tabs carrying a second status badge of
 * their own reading from the stream.
 */
function withStreamingLogs(): TrpcFixtures {
  const readiness = configuringFixtures.onboarding?.getPreviewReadiness;
  return {
    ...configuringFixtures,
    onboarding: {
      ...configuringFixtures.onboarding,
      getPreviewReadiness:
        readiness == null
          ? readiness
          : {
              ...readiness,
              diagnostics: {
                status: "building",
                phase: "deploying-services",
                actions: [],
                logs: { available: true, repoFullName: "acme/storefront", prNumber: 0 },
              },
            },
    },
  };
}

/**
 * A deploy that failed and is not being retried yet - the state the screen spends most
 * of its time in after a bad build, while the agent reads the error and edits config.
 * Nothing is producing log lines, so the panel is a toggle rather than an open terminal.
 */
function withFailedDeploy(): TrpcFixtures {
  const readiness = configuringFixtures.onboarding?.getPreviewReadiness;
  return {
    ...configuringFixtures,
    onboarding: {
      ...configuringFixtures.onboarding,
      getPreviewReadiness:
        readiness == null
          ? readiness
          : {
              ...readiness,
              diagnostics: {
                status: "failed",
                phase: "building-images",
                error: 'app "api": image build failed: step 6/9 `RUN pnpm build` exited with code 1',
                actions: [],
                logs: { available: true, repoFullName: "acme/storefront", prNumber: 0 },
              },
              services: [
                { name: "web", kind: "app", status: "ready", statusSource: "cluster" },
                { name: "api", kind: "app", status: "failed", statusSource: "pipeline" },
                { name: "db", kind: "managed", status: "ready", statusSource: "cluster" },
                { name: "redis", kind: "managed", status: "ready", statusSource: "cluster" },
              ],
            },
    },
  };
}

/** Any fixture set with its agent heartbeat pushed past the stalled threshold. */
function withStaleHeartbeat(fixtures: TrpcFixtures): TrpcFixtures {
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

/**
 * A deploy that was requested and produced nothing at all - no environment, no build,
 * no logs. Distinct from {@link withFailedDeploy}, where a build ran and failed: here
 * there is no service state to show, which is what makes the message the entire screen.
 */
function withNeverStartedDeploy(diagnostics: {
  status: "idle" | "failed";
  phase?: string;
  error: string;
}): TrpcFixtures {
  const readiness = configuringFixtures.onboarding?.getPreviewReadiness;
  return {
    ...configuringFixtures,
    onboarding: {
      ...configuringFixtures.onboarding,
      getPreviewReadiness:
        readiness == null
          ? readiness
          : {
              ...readiness,
              diagnostics: { ...diagnostics, actions: [], logs: { available: false } },
              services: [],
            },
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
 * The end of the agent-driven preview flow: the preview is verified and nothing is
 * left for the user to press. The agent goes live from here and the screen resumes
 * the onboarding flow at whatever step is genuinely next, not the app home.
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
 * Mid-deploy with the log stream mounted. One status and one phase, above the tabs -
 * the log card no longer carries its own badge fed by the stream, which is how the
 * page came to read "DEPLOY building" beside "build logs failed".
 */
export const DeployStreaming: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: [logStreamHandler({ build: buildFrames, app: appFrames }), ...appShellHandlers(withStreamingLogs())],
    },
  },
};

/**
 * The last deploy failed and nothing is running. The error is stated in full, and the
 * logs behind it are one click away rather than open - an open terminal with a finished
 * deploy's output in it reads as the state of right now, which is what made the screen
 * look permanently broken while the agent was quietly fixing the config.
 */
export const DeployFailedIdle: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: [logStreamHandler({ build: buildFrames, app: [] }), ...appShellHandlers(withFailedDeploy())],
    },
  },
};

/**
 * The same failed deploy, but the agent has gone quiet without retrying. This is the
 * one failure that genuinely needs the user, so it keeps the warning tone and asks
 * for the nudge - the contrast with `DeployFailedIdle` is the whole point.
 */
export const DeployFailedAgentQuiet: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: buildFrames, app: [] }),
        ...appShellHandlers(withStaleHeartbeat(withFailedDeploy())),
      ],
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
      handlers: appShellHandlers(withStaleHeartbeat(withPreviewPath("existing_deploys"))),
    },
  },
};

/**
 * What a deploy that never started said BEFORE the reason was persisted: readiness
 * explained the failure on the transition, then the status it wrote in the same breath
 * moved the next poll off that branch and onto this generic message. Kept as a story
 * because it is the state a user actually sat in front of, and it reads as "nothing was
 * ever attempted" on an app whose deploy had been requested three times.
 */
export const DeployNeverStartedGenericMessage: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        withNeverStartedDeploy({
          status: "idle",
          phase: "workflow_not_started",
          error:
            "No PreviewKit environment row exists yet. Start or redeploy the main environment after saving config.",
        }),
      ),
    },
  },
};

/** The same poll with the reason persisted: the diagnosis survives the write that recorded it. */
export const DeployNeverStartedReasonKept: Story = {
  args: { applicationId: baseApplication.id },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        // No phase: `failedReadiness` sets none, and a phase of "deploy_requested" would render
        // the request-accepted stepper over a deploy that has already been given up on.
        withNeverStartedDeploy({
          status: "failed",
          error:
            "PreviewKit accepted the deploy request, but no environment was created. Check PreviewKit service health, then redeploy.",
        }),
      ),
    },
  },
};
