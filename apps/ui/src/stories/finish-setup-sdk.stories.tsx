import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";
import { HttpResponse, http } from "msw";
import { userEvent, within } from "storybook/test";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const PREVIEW_URL = "https://acme-web-pr-42.preview.autonoma.app";

type SdkDryRunTargets = RouterOutputs["onboarding"]["listSdkDryRunTargets"];
type SdkDryRunTarget = SdkDryRunTargets["targets"][number];

/**
 * Onboarding mid-setup: CLI artifacts uploaded, SDK not yet validated - the
 * state in which the finish-setup page lands on the SDK step.
 */
function makeOnboardingState(): RouterOutputs["onboarding"]["getState"] {
  return {
    id: "onboarding_fixture_01",
    applicationId: baseApplication.id,
    step: "completed",
    agentConnectedAt: null,
    agentLogs: [],
    productionUrl: "https://app.acme.example.com",
    previewEnvironmentMode: "previewkit",
    previewUrl: null,
    previewVerificationStatus: "ready",
    previewDeployRequestedAt: null,
    completedAt: FIXTURE_EPOCH,
    lastDiscoveryError: null,
    lastDiscoveredAt: null,
    lastDiscoveredModels: null,
    discoveringStartedAt: null,
    dryRunPassedAt: null,
    diffTriggerConfirmedAt: null,
    agentHolder: "human",
    agentLastActivityAt: null,
    agentPendingRequest: null,
    agentPairingCode: null,
    agentPairingExpiresAt: null,
    agentClient: null,
    createdAt: FIXTURE_EPOCH,
    updatedAt: FIXTURE_EPOCH,
    sdkConfigured: false,
    dryRunPassed: false,
    discoveryInProgress: false,
    artifactsUploaded: true,
    hasContent: true,
    setupComplete: false,
  };
}

/**
 * Onboarding before the planner has ever run: no artifact has landed, so the
 * page opens on the CLI step with every checklist row still pending.
 */
function makeArtifactsState(): RouterOutputs["onboarding"]["getState"] {
  return {
    ...makeOnboardingState(),
    artifactsUploaded: false,
    hasContent: false,
  };
}

/**
 * Onboarding after a successful SDK validation: the endpoint answered discover
 * and reported its models, which is what renders the confirmation chip next to
 * the Validate SDK button.
 */
function makeSdkValidatedState(): RouterOutputs["onboarding"]["getState"] {
  return {
    ...makeOnboardingState(),
    sdkConfigured: true,
    lastDiscoveredAt: FIXTURE_EPOCH,
    lastDiscoveredModels: 12,
  };
}

const artifactStatus: RouterOutputs["applicationSetups"]["artifactStatus"] = {
  complete: true,
  stepComplete: true,
  artifacts: [
    { key: "recipe", received: true, meta: "3 scenarios" },
    { key: "tests", received: true, meta: "14 files" },
    { key: "kb", received: true },
    { key: "scenarios", received: true },
  ],
};

const pendingArtifactStatus: RouterOutputs["applicationSetups"]["artifactStatus"] = {
  complete: false,
  stepComplete: false,
  artifacts: [
    { key: "recipe", received: false },
    { key: "tests", received: false },
    { key: "kb", received: false },
    { key: "scenarios", received: false },
  ],
};

/** The token + generation id the CLI step bakes into its copyable command. */
const cliSetup: RouterOutputs["applicationSetups"]["prepareCliSetup"] = {
  // Deliberately shaped like a placeholder, not like a credential: this story is
  // the source of a published docs screenshot, and a realistic-looking token there
  // teaches readers that pasting real ones into screenshots is fine.
  apiKey: "ask_your_api_token_here",
  setupId: "your_generation_id_here",
};

const mainTarget: SdkDryRunTarget = {
  id: "main",
  kind: "main",
  source: "previewkit",
  label: "main",
  prNumber: 0,
  environmentId: "env_fixture_main",
  repoFullName: "acme/web",
  sdkAppName: "web",
  status: "ready",
  availability: "ready",
  previewUrl: "https://acme-web-main.preview.autonoma.app",
  sdkUrl: "https://acme-web-main.preview.autonoma.app/api/autonoma",
  requiresSharedSecretInput: false,
  isAutoDetected: false,
};

const readyTargets: SdkDryRunTargets = {
  autoDetectedTargetId: "pr-42",
  targets: [
    {
      id: "pr-42",
      kind: "pr",
      source: "previewkit",
      label: "feat: autonoma-sdk endpoint",
      prNumber: 42,
      environmentId: "env_fixture_42",
      repoFullName: "acme/web",
      sdkAppName: "web",
      status: "ready",
      availability: "ready",
      previewUrl: PREVIEW_URL,
      sdkUrl: `${PREVIEW_URL}/api/autonoma`,
      requiresSharedSecretInput: false,
      isAutoDetected: true,
    },
    mainTarget,
    {
      id: "pr-41",
      kind: "pr",
      source: "previewkit",
      label: "fix: checkout rounding on coupon removal",
      prNumber: 41,
      environmentId: "env_fixture_41",
      repoFullName: "acme/web",
      status: "building",
      availability: "building",
      requiresSharedSecretInput: false,
      isAutoDetected: false,
    },
  ],
};

const failedTargets: SdkDryRunTargets = {
  autoDetectedTargetId: "pr-42",
  targets: [
    {
      id: "pr-42",
      kind: "pr",
      source: "previewkit",
      label: "feat: autonoma-sdk endpoint",
      prNumber: 42,
      environmentId: "env_fixture_42",
      repoFullName: "acme/web",
      status: "failed",
      availability: "failed",
      error: 'app "web": image build failed: step 8/12 `RUN pnpm build` exited with code 1',
      headRef: "feat/autonoma-sdk",
      headSha: "d34db33f00d5",
      requiresSharedSecretInput: false,
      isAutoDetected: true,
    },
    mainTarget,
  ],
};

const buildingTargets: SdkDryRunTargets = {
  autoDetectedTargetId: "pr-42",
  targets: [
    {
      id: "pr-42",
      kind: "pr",
      source: "previewkit",
      label: "feat: autonoma-sdk endpoint",
      prNumber: 42,
      environmentId: "env_fixture_42",
      repoFullName: "acme/web",
      status: "building",
      availability: "building",
      headRef: "feat/autonoma-sdk",
      headSha: "d34db33f00d5",
      requiresSharedSecretInput: false,
      isAutoDetected: true,
    },
    mainTarget,
  ],
};

const headCommit: RouterOutputs["github"]["getCommit"] = {
  sha: "d34db33f00d5",
  message:
    "feat: add autonoma environment factory endpoint\n\nMounts /api/autonoma with factories for Organization and User,\nreading both managed secrets from the environment.",
  authorLogin: "ada-lovelace",
  files: [
    { filename: "src/routes/autonoma.ts", status: "added", additions: 84, deletions: 0 },
    { filename: "package.json", status: "modified", additions: 2, deletions: 0 },
  ],
};

const noPreviewTargets: SdkDryRunTargets = {
  autoDetectedTargetId: "pr-43",
  targets: [
    {
      id: "pr-43",
      kind: "pr",
      source: "external",
      label: "feat: autonoma-sdk endpoint",
      prNumber: 43,
      availability: "no_preview",
      requiresSharedSecretInput: false,
      isAutoDetected: true,
    },
    mainTarget,
  ],
};

// The app shell's sidebar (milestones) reads these on every page under the shell.
const sidebarFixtures: TrpcFixtures = {
  branches: {
    list: branchPage(),
    detailByName: {
      id: baseApplication.mainBranchId ?? "branch_fixture_01",
      name: "main",
      pendingSnapshotId: null,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      activeSnapshot: {
        id: "snapshot_fixture_01",
        status: "active",
        createdAt: FIXTURE_EPOCH,
        source: "MANUAL",
        testCaseAssignments: [],
      },
    },
  },
};

/** A GitHub/PreviewKit app, so the SDK step renders the BYO preview-target flow. */
const noVercelProjects: RouterOutputs["onboarding"]["listAvailableVercelProjects"] = {
  connected: false,
  projects: [],
  connectUrl: "https://vercel.com/integrations/autonoma/new",
  linkedProject: undefined,
};

function sdkStepFixtures(
  targets: SdkDryRunTargets,
  state: RouterOutputs["onboarding"]["getState"] = makeOnboardingState(),
): TrpcFixtures {
  return {
    onboarding: {
      getState: state,
      listSdkDryRunTargets: targets,
      prepareSdkTarget: { status: "ready" },
      listAvailableVercelProjects: noVercelProjects,
    },
    github: { getCommit: headCommit },
    applicationSetups: { artifactStatus },
    applications: { list: [baseApplication], getSharedSecret: { sharedSecret: "your_shared_secret_here" } },
    ...sidebarFixtures,
  };
}

/**
 * The CLI step: nothing uploaded yet, so the page opens on it and the checklist
 * reads as pending. The step mints its own API token + generation id through
 * `prepareCliSetup`, which is what fills in the copyable command.
 */
function artifactsStepFixtures(): TrpcFixtures {
  return {
    onboarding: {
      getState: makeArtifactsState(),
      listSdkDryRunTargets: readyTargets,
    },
    applicationSetups: { artifactStatus: pendingArtifactStatus, prepareCliSetup: cliSetup },
    applications: { list: [baseApplication], getSharedSecret: { sharedSecret: "your_shared_secret_here" } },
    ...sidebarFixtures,
  };
}

/**
 * Onboarding one step further than the SDK fixtures: the SDK is validated
 * (`sdkConfigured`), so the page lands on the dry-run step. The dry-run step
 * inherits the SDK step's target read-only, so no target picker fixture is
 * needed beyond the same `listSdkDryRunTargets`.
 */
const scenarioList: RouterOutputs["scenarios"]["list"] = [
  {
    id: "scenario_standard",
    applicationId: baseApplication.id,
    name: "standard",
    description: "One organization with an owner and three seats on the Pro plan.",
    activeRecipeVersionId: "recipe_version_standard",
    lastSeenFingerprint: null,
    lastDiscoveredAt: FIXTURE_EPOCH,
    fingerprintChangedAt: null,
    isDisabled: false,
    createdAt: FIXTURE_EPOCH,
    updatedAt: FIXTURE_EPOCH,
    organizationId: baseApplication.organizationId,
  },
];

function makeDryRunState(): RouterOutputs["onboarding"]["getState"] {
  return {
    ...makeOnboardingState(),
    sdkConfigured: true,
    lastDiscoveredAt: FIXTURE_EPOCH,
    lastDiscoveredModels: 2,
    dryRunPassed: false,
  };
}

function dryRunStepFixtures(targets: SdkDryRunTargets): TrpcFixtures {
  return {
    onboarding: {
      getState: makeDryRunState(),
      listSdkDryRunTargets: targets,
    },
    applicationSetups: { artifactStatus },
    applications: { list: [baseApplication] },
    scenarios: { list: scenarioList },
    ...sidebarFixtures,
  };
}

/**
 * A validated SDK step. Because the step is complete the page opens on the
 * dry-run step, so the story walks back to the SDK step - which is why the
 * dry-run step's scenario list is fixtured here too.
 */
function sdkValidatedFixtures(): TrpcFixtures {
  return {
    ...sdkStepFixtures(readyTargets, makeSdkValidatedState()),
    scenarios: { list: scenarioList },
  };
}

/** One SSE frame per event, in the previewkit stream's wire format (Loki-style nanosecond ids). */
function sseFrames(events: Array<{ event: string; data?: object | string; at: Date }>): string {
  return events
    .map((entry) => {
      const data = typeof entry.data === "string" ? entry.data : JSON.stringify(entry.data ?? {});
      return `id: ${entry.at.getTime()}000000\nevent: ${entry.event}\ndata: ${data}\n\n`;
    })
    .join("");
}

/**
 * Answers the previewkit log-stream SSE endpoint. The stream is closed after
 * the canned frames - the screenshot script waits for network idle, which an
 * open SSE connection would block forever.
 */
function logStreamHandler(frames: { build: string; app: string }) {
  return http.get("*/v1/previewkit/environments/:owner/:repo/:pr/logs/stream", ({ request }) => {
    const source = new URL(request.url).searchParams.get("source") === "app" ? "app" : "build";
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(frames[source]));
        controller.close();
      },
    });
    return new HttpResponse(body, { headers: { "Content-Type": "text/event-stream" } });
  });
}

const at = (second: number) => new Date(FIXTURE_EPOCH.getTime() + second * 1000);

const failedBuildFrames = sseFrames([
  { event: "phase", data: { kind: "phase", message: "cloning repository" }, at: at(0) },
  { event: "log", data: { kind: "log", message: "acme/web@d34db33 extracted (412 files)" }, at: at(2) },
  { event: "phase", data: { kind: "phase", message: "building images" }, at: at(3) },
  { event: "log", data: { kind: "log", message: "#8 [5/9] RUN pnpm install --frozen-lockfile" }, at: at(9) },
  { event: "log", data: { kind: "log", message: "#8 DONE 41.3s" }, at: at(51) },
  { event: "log", data: { kind: "log", message: "#9 [6/9] RUN pnpm build" }, at: at(52) },
  {
    event: "log",
    data: {
      kind: "log",
      stream: "stderr",
      message: 'src/routes/autonoma.ts(12,3): error TS2304: Cannot find name "createHandler".',
    },
    at: at(68),
  },
  {
    event: "log",
    data: { kind: "log", stream: "stderr", message: "ELIFECYCLE Command failed with exit code 1." },
    at: at(69),
  },
  { event: "status", data: { kind: "status", message: "failed" }, at: at(70) },
  { event: "done", data: "failed", at: at(70) },
]);

const idleAppFrames = sseFrames([]);

const inProgressBuildFrames = sseFrames([
  { event: "phase", data: { kind: "phase", message: "cloning repository" }, at: at(0) },
  { event: "log", data: { kind: "log", message: "acme/web@d34db33 extracted (412 files)" }, at: at(2) },
  { event: "phase", data: { kind: "phase", message: "building images" }, at: at(3) },
  { event: "log", data: { kind: "log", message: "#7 [4/9] COPY . /app" }, at: at(6) },
  { event: "log", data: { kind: "log", message: "#8 [5/9] RUN pnpm install --frozen-lockfile" }, at: at(9) },
  { event: "log", data: { kind: "log", message: "#8 41.2s progress: resolved 1247, downloaded 1189" }, at: at(50) },
]);

/**
 * The finish-setup SDK step across the preview-target states the deploy/redeploy
 * button covers: a ready target (redeploy at the latest head), a failed deploy
 * (redeploy to retry), and an open PR with no preview at all (first deploy).
 */
const meta = {
  title: "Pages/FinishSetupSdk",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const PATH = `/app/${baseApplication.slug}/finish-setup`;

/**
 * The first step, before the planner has run: the copyable CLI command carrying
 * the API token and generation id, and the artifact checklist still pending.
 */
export const ArtifactsStep: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: appShellHandlers(artifactsStepFixtures()) } },
};

/**
 * The CLI step once every artifact has landed: the chips fill in and the count
 * reads 4/4. A complete CLI step means the page opens on the SDK step, so the
 * story walks back to it.
 */
export const ArtifactsStepComplete: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...sdkStepFixtures(readyTargets),
        applicationSetups: { artifactStatus, prepareCliSetup: cliSetup },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const cliStep = await canvas.findByRole("button", { name: /Upload test artifacts/ }, { timeout: 10_000 });
    await userEvent.click(cliStep);
    await canvas.findByText("4/4", undefined, { timeout: 10_000 });
  },
};

export const TargetReady: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: appShellHandlers(sdkStepFixtures(readyTargets)) } },
};

/**
 * The SDK step after a successful validation, showing the "Discovered 12 models"
 * chip. A complete SDK step means the page opens on the dry-run step, so the
 * story clicks the SDK entry in the stepper to get back to it.
 */
export const SdkValidated: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: appShellHandlers(sdkValidatedFixtures()) } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The whole page arrives behind a route loader and a Suspense boundary, so
    // give both queries longer than the 1s testing-library default.
    const sdkStep = await canvas.findByRole("button", { name: /Implement the Autonoma SDK/ }, { timeout: 10_000 });
    await userEvent.click(sdkStep);
    await canvas.findByText(/Discovered 12 models/, undefined, { timeout: 10_000 });
  },
};

export const TargetFailed: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: failedBuildFrames, app: idleAppFrames }),
        ...appShellHandlers(sdkStepFixtures(failedTargets)),
      ],
    },
  },
};

export const TargetNoPreview: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: appShellHandlers(sdkStepFixtures(noPreviewTargets)) } },
};

/**
 * The dry-run step, one step past the SDK step. It inherits the target validated
 * on the SDK step (the auto-detected SDK PR here) and shows it read-only - there
 * is no second picker to keep in sync.
 */
export const DryRunStep: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: appShellHandlers(dryRunStepFixtures(readyTargets)) } },
};

export const TargetBuilding: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: inProgressBuildFrames, app: idleAppFrames }),
        ...appShellHandlers(sdkStepFixtures(buildingTargets)),
      ],
    },
  },
};
