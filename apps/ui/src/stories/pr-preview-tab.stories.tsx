import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { HttpResponse, http } from "msw";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const BUILD_STARTED_AT = new Date("2026-01-01T11:27:14.000Z");
const BUILD_FINISHED_AT = new Date("2026-01-01T11:28:20.000Z");
const PR_NUMBER = 2624;
const ENVIRONMENT_ID = "env_fixture_01";
const BRANCH_NAME = "eng-1665-make-the-search-icon-clickable-for-the-search-widget";
const HEAD_SHA = "a22387c9d4e1f6b8a0c3d5e7f9012345678901ab";
const BASE_SHA = "9f1c2d3e4b5a6f708192a3b4c5d6e7f809182736";

type PreviewServiceFixture = ReturnType<typeof appService> | ReturnType<typeof dependencyService>;

function appService({
  name,
  kind,
  iconKey,
  buildDurationMs,
  status = "failed",
  statusReason = "buildctl exited with code 1",
  endpoint = null,
}: {
  name: string;
  kind: "web" | "api" | "worker";
  iconKey: "web" | "api" | "worker";
  buildDurationMs: number;
  status?: "ready" | "failed";
  statusReason?: string | null;
  endpoint?: string | null;
}) {
  return {
    name,
    kind,
    iconKey,
    status,
    logAvailability: "build_and_runtime" as const,
    branch: BRANCH_NAME,
    branchSource: "matched_pr_branch" as const,
    branchHint: "matched PR branch",
    endpoint,
    port: null,
    imageTag: null,
    buildLogUrl: null,
    buildDurationMs,
    statusReason,
    lastBuiltAt: BUILD_FINISHED_AT,
    lastDeployedAt: FIXTURE_EPOCH,
  };
}

function dependencyService({
  name,
  kind,
  iconKey,
  endpoint,
}: {
  name: string;
  kind: "database" | "service";
  iconKey: "postgres" | "cache" | "temporal";
  endpoint: string;
}) {
  return {
    name,
    kind,
    iconKey,
    status: "ready" as const,
    logAvailability: "runtime_only" as const,
    branch: null,
    branchSource: "unknown" as const,
    branchHint: null,
    endpoint,
    port: null,
    imageTag: null,
    buildLogUrl: null,
    buildDurationMs: null,
    statusReason: null,
    lastBuiltAt: null,
    lastDeployedAt: FIXTURE_EPOCH,
  };
}

const PREVIEW_SERVICES: PreviewServiceFixture[] = [
  appService({ name: "web-app", kind: "web", iconKey: "web", buildDurationMs: 50_000 }),
  appService({ name: "db-api", kind: "api", iconKey: "api", buildDurationMs: 12_000 }),
  appService({ name: "temporal-worker", kind: "worker", iconKey: "worker", buildDurationMs: 8_000 }),
  dependencyService({ name: "db", kind: "database", iconKey: "postgres", endpoint: "db.preview-2624.internal:5432" }),
  dependencyService({ name: "cache", kind: "service", iconKey: "cache", endpoint: "cache.preview-2624.internal:6379" }),
  dependencyService({
    name: "temporal",
    kind: "service",
    iconKey: "temporal",
    endpoint: "temporal.preview-2624.internal:7233",
  }),
];

/**
 * Shared by `previewSummaryByPr` and `previewSummaryById` - both return the same shape for a
 * previewkit-backed environment. Mirrors the redesign reference mockup's failed-build scenario: all
 * three apps failed on the same broken `SearchWidget` prop, dependency services still running.
 */
function previewkitSummary() {
  return {
    source: "previewkit" as const,
    environmentId: ENVIRONMENT_ID,
    repoFullName: "acme/acme-web",
    prNumber: PR_NUMBER,
    branch: BRANCH_NAME,
    status: "failed" as const,
    primaryUrl: null,
    phase: "build_failed",
    error: "All app builds failed; see per-app build outcomes for details.",
    headSha: HEAD_SHA,
    lastDeployedSha: HEAD_SHA,
    updatedAt: BUILD_FINISHED_AT,
    deployedAt: BUILD_FINISHED_AT,
    serviceCount: PREVIEW_SERVICES.length,
    readyServiceCount: 3,
    degradedServiceCount: 0,
    failedServiceCount: 3,
    services: PREVIEW_SERVICES,
    latestBuild: {
      headSha: HEAD_SHA,
      status: "failed" as const,
      durationMs: 50_000,
      error: "All app builds failed; see per-app build outcomes for details.",
      startedAt: BUILD_STARTED_AT,
      finishedAt: BUILD_FINISHED_AT,
    },
    actions: {
      openPreview: { enabled: false, href: null, reason: "No preview URL is available yet." },
    },
  };
}

const READY_PREVIEW_SERVICES: PreviewServiceFixture[] = [
  appService({
    name: "web-app",
    kind: "web",
    iconKey: "web",
    buildDurationMs: 42_000,
    status: "ready",
    statusReason: null,
    endpoint: "https://web-app.preview-2624.internal",
  }),
  appService({
    name: "db-api",
    kind: "api",
    iconKey: "api",
    buildDurationMs: 11_000,
    status: "ready",
    statusReason: null,
    endpoint: "https://db-api.preview-2624.internal",
  }),
  appService({
    name: "temporal-worker",
    kind: "worker",
    iconKey: "worker",
    buildDurationMs: 7_000,
    status: "ready",
    statusReason: null,
  }),
  dependencyService({ name: "db", kind: "database", iconKey: "postgres", endpoint: "db.preview-2624.internal:5432" }),
  dependencyService({ name: "cache", kind: "service", iconKey: "cache", endpoint: "cache.preview-2624.internal:6379" }),
  dependencyService({
    name: "temporal",
    kind: "service",
    iconKey: "temporal",
    endpoint: "temporal.preview-2624.internal:7233",
  }),
];

/**
 * Same environment, healthy: all apps deployed successfully. Exercises the Test User provision flow
 * (scenario picker -> credentials) and a multi-entry deployment history.
 */
function readyPreviewkitSummary() {
  return {
    source: "previewkit" as const,
    environmentId: ENVIRONMENT_ID,
    repoFullName: "acme/acme-web",
    prNumber: PR_NUMBER,
    branch: BRANCH_NAME,
    status: "ready" as const,
    primaryUrl: "https://web-app.preview-2624.internal",
    phase: null,
    error: null,
    headSha: HEAD_SHA,
    lastDeployedSha: HEAD_SHA,
    updatedAt: BUILD_FINISHED_AT,
    deployedAt: BUILD_FINISHED_AT,
    serviceCount: READY_PREVIEW_SERVICES.length,
    readyServiceCount: READY_PREVIEW_SERVICES.length,
    degradedServiceCount: 0,
    failedServiceCount: 0,
    services: READY_PREVIEW_SERVICES,
    latestBuild: {
      headSha: HEAD_SHA,
      status: "ready" as const,
      durationMs: 42_000,
      error: null,
      startedAt: BUILD_STARTED_AT,
      finishedAt: BUILD_FINISHED_AT,
    },
    actions: {
      openPreview: { enabled: true, href: "https://web-app.preview-2624.internal", reason: null },
    },
  };
}

// The app shell's sidebar (finish-setup nudge) reads this on every page; completed hides the nudge.
function completedOnboardingState() {
  return {
    id: "onboarding_fixture_01",
    applicationId: baseApplication.id,
    step: "completed" as const,
    agentConnectedAt: null,
    agentLogs: [],
    productionUrl: "https://app.acme.example.com",
    previewEnvironmentMode: "previewkit" as const,
    previewUrl: null,
    previewVerificationStatus: "ready" as const,
    previewDeployRequestedAt: null,
    completedAt: FIXTURE_EPOCH,
    lastDiscoveryError: null,
    lastDiscoveredAt: FIXTURE_EPOCH,
    lastDiscoveredModels: 12,
    discoveringStartedAt: null,
    dryRunPassedAt: FIXTURE_EPOCH,
    diffTriggerConfirmedAt: FIXTURE_EPOCH,
    agentHolder: "human" as const,
    agentLastActivityAt: null,
    agentPendingRequest: null,
    agentPairingCode: null,
    agentPairingExpiresAt: null,
    agentClient: null,
    createdAt: FIXTURE_EPOCH,
    updatedAt: FIXTURE_EPOCH,
    sdkConfigured: true,
    dryRunPassed: true,
    discoveryInProgress: false,
    artifactsUploaded: true,
    hasContent: true,
    setupComplete: true,
  };
}

// Fixtures the app shell itself needs on every page (sidebar milestones/bugs/finish-setup-nudge) plus
// the PR's own branch/GitHub metadata - identical across every story in this file.
const SHARED_FIXTURES: TrpcFixtures = {
  branches: {
    // The app shell's sidebar (milestones) reads these on every page.
    list: [],
    // No checkpoints yet for this PR - exercises the Overview tab's empty state under the new
    // fixed-viewport shell (checkpoint content itself is unrelated to this PR's shell change).
    snapshotHistory: [],
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
    detailByPr: {
      id: "branch_fixture_pr_01",
      name: BRANCH_NAME,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      prNumber: PR_NUMBER,
      prTitle: "Make the search icon clickable for the search widget",
    },
    pipelineStatusByBranchId: { kind: "none" },
  },
  github: {
    getApplicationRepository: {
      id: baseApplication.githubRepositoryId ?? 123456,
      name: "acme-web",
      fullName: "acme/acme-web",
      defaultBranch: "main",
      private: true,
    },
    getPullRequest: {
      number: PR_NUMBER,
      title: "Make the search icon clickable for the search widget",
      headRef: BRANCH_NAME,
      headSha: HEAD_SHA,
      baseRef: "main",
      baseSha: BASE_SHA,
      url: `https://github.com/acme/acme-web/pull/${PR_NUMBER}`,
      authorLogin: "jrivera",
      createdAt: FIXTURE_EPOCH.toISOString(),
      updatedAt: FIXTURE_EPOCH.toISOString(),
      state: "open",
      commitsCount: 4,
      merged: false,
    },
    listPullRequestCommits: [
      {
        sha: HEAD_SHA,
        message: "Wire up search icon click handler",
        authorLogin: "jrivera",
        authoredAt: FIXTURE_EPOCH.toISOString(),
      },
    ],
  },
  bugs: { listSummary: [] },
  onboarding: { getState: completedOnboardingState() },
};

/**
 * Page fixtures for the PR Preview tab: a previewkit environment whose three apps all failed to
 * build, with dependency services still healthy, and no test user (gated behind "ready"). Realistic
 * enough to exercise the failed/error styling throughout the shell, rail, inspector, and logs.
 */
const previewTabFixtures: TrpcFixtures = {
  ...SHARED_FIXTURES,
  deployments: {
    previewSummaryByPr: previewkitSummary(),
    previewSummaryById: previewkitSummary(),
    history: [
      {
        id: "build_fixture_01",
        headSha: HEAD_SHA,
        status: "failed",
        startedAt: BUILD_STARTED_AT,
        finishedAt: BUILD_FINISHED_AT,
        durationMs: 66_000,
        isCurrent: true,
      },
    ],
  },
};

/**
 * Same environment, healthy: exercises the environment summary strip's Deployment history dialog
 * (two entries) and the Test User provision flow (scenario picker -> credentials).
 */
const readyPreviewTabFixtures: TrpcFixtures = {
  ...SHARED_FIXTURES,
  deployments: {
    previewSummaryByPr: readyPreviewkitSummary(),
    previewSummaryById: readyPreviewkitSummary(),
    history: [
      {
        id: "build_fixture_ready_01",
        headSha: HEAD_SHA,
        status: "success",
        startedAt: BUILD_STARTED_AT,
        finishedAt: BUILD_FINISHED_AT,
        durationMs: 42_000,
        isCurrent: true,
      },
      {
        id: "build_fixture_ready_00",
        headSha: BASE_SHA,
        status: "success",
        startedAt: new Date("2025-12-31T10:00:00.000Z"),
        finishedAt: new Date("2025-12-31T10:00:55.000Z"),
        durationMs: 55_000,
        isCurrent: false,
      },
    ],
    testUserOptions: {
      applicationId: baseApplication.id,
      applicationName: baseApplication.name,
      scenarios: [
        { id: "scenario_default", name: "Default signed-in user" },
        { id: "scenario_admin", name: "Admin user" },
      ],
      appUrls: [{ appName: "web-app", url: "https://web-app.preview-2624.internal" }],
      suggestedSdkUrl: "https://web-app.preview-2624.internal",
      previewUrl: "https://web-app.preview-2624.internal",
      disabledReason: undefined,
    },
    testUserProvision: {
      instanceId: "instance_fixture_01",
      auth: {
        credentials: { email: "test-user@acme.example.com", password: "Pr3v13wUser!23" },
      },
      refs: {},
      refsToken: "refs_token_fixture",
      resolvedVariables: {},
    },
  },
};

/**
 * Page-story coverage for the PR's Preview tab - the fixed-viewport "control room" redesign. Renders
 * the real route tree end to end (shared PR header + tab bar, resource rail, app inspector, logs,
 * deployment rail) with no backend involved.
 */
const meta = {
  title: "Pages/PRPreviewTab",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const PREVIEW_PATH = `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/preview`;

export const BuildFailed: Story = {
  args: { path: PREVIEW_PATH },
  parameters: { msw: { handlers: appShellHandlers(previewTabFixtures) } },
};

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
 * Answers the previewkit log-stream SSE endpoint. The stream is closed after the canned frames - the
 * screenshot script waits for network idle, which an open SSE connection would block forever.
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

const readyAt = (second: number) => new Date(FIXTURE_EPOCH.getTime() + second * 1000);

const readyBuildFrames = sseFrames([
  { event: "phase", data: { kind: "phase", message: "cloning repository" }, at: readyAt(0) },
  { event: "log", data: { kind: "log", message: "acme/web-app@a22387c extracted (412 files)" }, at: readyAt(2) },
  { event: "phase", data: { kind: "phase", message: "building images" }, at: readyAt(3) },
  { event: "log", data: { kind: "log", message: "#8 [5/9] RUN pnpm install --frozen-lockfile" }, at: readyAt(9) },
  { event: "log", data: { kind: "log", message: "#8 DONE 41.3s" }, at: readyAt(51) },
  { event: "status", data: { kind: "status", message: "ready" }, at: readyAt(52) },
  { event: "done", data: "ready", at: readyAt(52) },
]);

const readyAppFrames = sseFrames([
  { event: "log", data: { kind: "log", message: "Server listening on port 3000" }, at: readyAt(55) },
  { event: "log", data: { kind: "log", message: "GET /health 200 4ms" }, at: readyAt(58) },
]);

export const Ready: Story = {
  args: { path: PREVIEW_PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: readyBuildFrames, app: readyAppFrames }),
        ...appShellHandlers(readyPreviewTabFixtures),
      ],
    },
  },
};
