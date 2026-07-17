import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";
import { HttpResponse, http } from "msw";

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
      requiresSharedSecretInput: false,
      isAutoDetected: true,
    },
    mainTarget,
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

function sdkStepFixtures(targets: SdkDryRunTargets): TrpcFixtures {
  return {
    onboarding: {
      getState: makeOnboardingState(),
      listSdkDryRunTargets: targets,
      prepareSdkTarget: { status: "ready" },
    },
    applicationSetups: { artifactStatus },
    applications: { list: [baseApplication], getSharedSecret: { sharedSecret: "9f2c4a1e8b7d6c5f" } },
    // The app shell's sidebar (milestones) reads these on every page.
    branches: {
      list: [],
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
    bugs: { listSummary: [] },
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

export const TargetReady: Story = {
  args: { path: PATH },
  parameters: { msw: { handlers: appShellHandlers(sdkStepFixtures(readyTargets)) } },
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
