import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { logStreamHandler, type LogStreamEvent } from "lib/storybook/log-stream-handler";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { HttpResponse, http } from "msw";
import superjson from "superjson";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const BUILD_STARTED_AT = new Date("2026-01-01T11:27:14.000Z");
const BUILD_FINISHED_AT = new Date("2026-01-01T11:28:20.000Z");
const PR_NUMBER = 2624;
const ENVIRONMENT_ID = "env_fixture_01";
const BRANCH_NAME = "eng-1665-make-the-search-icon-clickable-for-the-search-widget";
const HEAD_SHA = "a22387c9d4e1f6b8a0c3d5e7f9012345678901ab";
const BASE_SHA = "9f1c2d3e4b5a6f708192a3b4c5d6e7f809182736";

/**
 * Real previewkit app URLs, for the liveness stories. `isPreviewUrl` pins https, the hex label and
 * `.preview.<VITE_INTERNAL_DOMAIN>` (defaulting to `autonoma.app`), so only a URL of this exact shape
 * makes `PreviewLink` route the wake action through the `/preview-waiting` screen rather than opening
 * a raw href - which is the behaviour the Idle story exists to show.
 */
const IDLE_WEB_APP_URL = "https://8005f6a9090f.preview.autonoma.app";
const IDLE_DB_API_URL = "https://3c91ad77e204.preview.autonoma.app";

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
    sdkAppUrl: null,
    sdkPath: null,
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
 * A successfully deployed environment. Parameterised by its services and front door because the
 * deploy outcome is the same whether the preview is currently serving, waking or scaled to zero -
 * liveness is a separate signal (`previewAccess.livenessForApplication`), which is exactly the
 * distinction the Idle stories below exercise.
 */
function readyPreviewkitSummary(services: PreviewServiceFixture[], primaryUrl: string) {
  return {
    source: "previewkit" as const,
    environmentId: ENVIRONMENT_ID,
    repoFullName: "acme/acme-web",
    prNumber: PR_NUMBER,
    branch: BRANCH_NAME,
    status: "ready" as const,
    primaryUrl,
    sdkAppUrl: primaryUrl,
    sdkPath: null,
    phase: null,
    error: null,
    headSha: HEAD_SHA,
    lastDeployedSha: HEAD_SHA,
    updatedAt: BUILD_FINISHED_AT,
    deployedAt: BUILD_FINISHED_AT,
    serviceCount: services.length,
    readyServiceCount: services.length,
    degradedServiceCount: 0,
    failedServiceCount: 0,
    services,
    latestBuild: {
      headSha: HEAD_SHA,
      status: "ready" as const,
      durationMs: 42_000,
      error: null,
      startedAt: BUILD_STARTED_AT,
      finishedAt: BUILD_FINISHED_AT,
    },
    actions: {
      openPreview: { enabled: true, href: primaryUrl, reason: null },
    },
  };
}

// The app shell's route guard reads this on every page; a completed setup is what keeps the app reachable.
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
    previewVerificationError: null,
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

// Fixtures the app shell itself needs on every page (sidebar milestones/bugs, onboarding state) plus
// the PR's own branch/GitHub metadata - identical across every story in this file.
const SHARED_FIXTURES: TrpcFixtures = {
  branches: {
    // The app shell's sidebar (milestones) reads these on every page.
    list: branchPage(),
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
  // Deployed and actually serving -> the strip shows a "Live" runtime badge
  // beside the deploy status (vs "Idle" had it scaled to zero).
  previewAccess: { livenessForApplication: { "https://web-app.preview-2624.internal": "healthy" } },
  deployments: {
    previewSummaryByPr: readyPreviewkitSummary(READY_PREVIEW_SERVICES, "https://web-app.preview-2624.internal"),
    previewSummaryById: readyPreviewkitSummary(READY_PREVIEW_SERVICES, "https://web-app.preview-2624.internal"),
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

/** Same healthy environment, but previewkit has no deployment row for it yet. */
const noDeploymentHistoryFixtures: TrpcFixtures = {
  ...readyPreviewTabFixtures,
  deployments: { ...readyPreviewTabFixtures.deployments, history: [] },
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

const readyAt = (second: number) => new Date(FIXTURE_EPOCH.getTime() + second * 1000);

const readyBuildFrames: LogStreamEvent[] = [
  { event: "phase", data: { kind: "phase", message: "cloning repository" }, at: readyAt(0) },
  { event: "log", data: { kind: "log", message: "acme/web-app@a22387c extracted (412 files)" }, at: readyAt(2) },
  { event: "phase", data: { kind: "phase", message: "building images" }, at: readyAt(3) },
  { event: "log", data: { kind: "log", message: "#8 [5/9] RUN pnpm install --frozen-lockfile" }, at: readyAt(9) },
  { event: "log", data: { kind: "log", message: "#8 DONE 41.3s" }, at: readyAt(51) },
  { event: "status", data: { kind: "status", message: "ready" }, at: readyAt(52) },
  { event: "done", data: "ready", at: readyAt(52) },
];

const readyAppFrames: LogStreamEvent[] = [
  { event: "log", data: { kind: "log", message: "Server listening on port 3000" }, at: readyAt(55) },
  { event: "log", data: { kind: "log", message: "GET /health 200 4ms" }, at: readyAt(58) },
];

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

/**
 * The same healthy deploy, with each app moved onto its real preview hostname so the wake action
 * resolves to `/preview-waiting`. Derived from `READY_PREVIEW_SERVICES` rather than copied, so a
 * change to the healthy fixture cannot silently stop applying to the liveness stories. Dependency
 * services keep their in-cluster host:port - a postgres pod has no public preview URL.
 */
const IDLE_APP_URLS: Record<string, string> = { "web-app": IDLE_WEB_APP_URL, "db-api": IDLE_DB_API_URL };

const IDLE_PREVIEW_SERVICES: PreviewServiceFixture[] = READY_PREVIEW_SERVICES.map((service) => {
  const endpoint = IDLE_APP_URLS[service.name];
  if (endpoint == null) return service;
  return { ...service, endpoint };
});

const idleDeploymentHistory = [
  {
    id: "build_fixture_idle_01",
    headSha: HEAD_SHA,
    status: "success" as const,
    startedAt: BUILD_STARTED_AT,
    finishedAt: BUILD_FINISHED_AT,
    durationMs: 42_000,
    isCurrent: true,
  },
];

/**
 * Fixtures for a preview that deployed fine and has since scaled to zero, differing from
 * `readyPreviewTabFixtures` in exactly one value: the liveness state. The deploy status stays
 * "success" throughout, which is the whole point - the deploy tells you nothing about whether
 * anything is running right now.
 */
function idlePreviewTabFixtures(livenessState: "asleep" | "waking"): TrpcFixtures {
  return {
    ...SHARED_FIXTURES,
    previewAccess: {
      livenessForApplication: { [IDLE_WEB_APP_URL]: livenessState, [IDLE_DB_API_URL]: livenessState },
    },
    deployments: {
      previewSummaryByPr: readyPreviewkitSummary(IDLE_PREVIEW_SERVICES, IDLE_WEB_APP_URL),
      previewSummaryById: readyPreviewkitSummary(IDLE_PREVIEW_SERVICES, IDLE_WEB_APP_URL),
      history: idleDeploymentHistory,
      // The inspector's Test User button fetches this on render for any environment whose deploy
      // succeeded, asleep or not.
      testUserOptions: {
        applicationId: baseApplication.id,
        applicationName: baseApplication.name,
        scenarios: [
          { id: "scenario_default", name: "Default signed-in user" },
          { id: "scenario_admin", name: "Admin user" },
        ],
        appUrls: [{ appName: "web-app", url: IDLE_WEB_APP_URL }],
        suggestedSdkUrl: IDLE_WEB_APP_URL,
        previewUrl: IDLE_WEB_APP_URL,
        disabledReason: undefined,
      },
    },
  };
}

/**
 * A preview scaled to zero, with no runtime output to show - the exact state the production
 * screenshot in the shape captured, where the App logs tab spun on "waiting for application output…"
 * indefinitely. The build stream still answers, so the Build logs tab keeps the finished build.
 */
export const Idle: Story = {
  args: { path: PREVIEW_PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: readyBuildFrames, app: [] }),
        ...appShellHandlers(idlePreviewTabFixtures("asleep")),
      ],
    },
  },
};

/**
 * The same environment mid-wake, with the app stream still silent. Identical to `Idle` in everything
 * but the liveness state, so it is the discriminating case: the log panel is back and waiting
 * honestly, which proves the idle panel keys on liveness rather than on an empty stream.
 */
export const Waking: Story = {
  args: { path: PREVIEW_PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: readyBuildFrames, app: [] }),
        ...appShellHandlers(idlePreviewTabFixtures("waking")),
      ],
    },
  },
};

/**
 * Asleep, but the app logged before it scaled down - Loki keeps that output. The idle panel replaces
 * the "waiting for output" spinner only, never real output, so the last thing the app said (often the
 * reason it went quiet) stays readable without waking it.
 */
export const IdleWithPastLogs: Story = {
  args: { path: PREVIEW_PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: readyBuildFrames, app: readyAppFrames }),
        ...appShellHandlers(idlePreviewTabFixtures("asleep")),
      ],
    },
  },
};

/**
 * An environment previewkit knows about but has no deployment row for yet. The summary strip falls back
 * to "No deployments yet." with History disabled - the state where reaching the previewkit config
 * matters most, since a preview that never deployed is usually a config problem.
 */
export const NoDeployments: Story = {
  args: { path: PREVIEW_PATH },
  parameters: {
    msw: {
      handlers: [
        logStreamHandler({ build: readyBuildFrames, app: readyAppFrames }),
        ...appShellHandlers(noDeploymentHistoryFixtures),
      ],
    },
  },
};

/**
 * Fails `deployments.history` (and whatever shares its tRPC batch, which is why the runtime badge is
 * absent too) so the strip renders its DeploymentSummaryErrorBoundary. Pins that the Preview settings
 * link is a sibling of that boundary rather than a child: a failed deployment fetch is precisely when a
 * reader wants the config, so it must not disappear with the summary.
 */
const deploymentHistoryFails = http.get("*/v1/trpc/*", ({ request }) => {
  const procedures = new URL(request.url).pathname.replace(/^.*\/v1\/trpc\//, "").split(",");
  if (!procedures.includes("deployments.history")) return undefined;
  return HttpResponse.json(
    procedures.map((procedure) => ({
      error: superjson.serialize({
        message: "Deployment history is unavailable.",
        code: -32603,
        data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
      }),
    })),
  );
});

export const DeploymentHistoryUnavailable: Story = {
  args: { path: PREVIEW_PATH },
  parameters: {
    msw: {
      // The narrow history override has to win over the catch-all fixture handler, so it goes first.
      handlers: [
        deploymentHistoryFails,
        logStreamHandler({ build: readyBuildFrames, app: readyAppFrames }),
        ...appShellHandlers(readyPreviewTabFixtures),
      ],
    },
  },
};
