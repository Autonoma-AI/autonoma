import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

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
}: {
  name: string;
  kind: "web" | "api" | "worker";
  iconKey: "web" | "api" | "worker";
  buildDurationMs: number;
}) {
  return {
    name,
    kind,
    iconKey,
    status: "failed" as const,
    logAvailability: "build_and_runtime" as const,
    branch: BRANCH_NAME,
    branchSource: "matched_pr_branch" as const,
    branchHint: "matched PR branch",
    endpoint: null,
    port: null,
    imageTag: null,
    buildLogUrl: null,
    buildDurationMs,
    statusReason: "buildctl exited with code 1",
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

/**
 * Page fixtures for the PR Preview tab: a previewkit environment whose three apps all failed to
 * build, with dependency services still healthy, and no test user (gated behind "ready"). Realistic
 * enough to exercise the failed/error styling throughout the shell, rail, inspector, and logs.
 */
const previewTabFixtures: TrpcFixtures = {
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
  // The app shell's sidebar (unresolved-bugs badge) reads this on every page.
  bugs: { listSummary: [] },
  // The app shell's sidebar (finish-setup nudge) reads this on every page.
  onboarding: { getState: completedOnboardingState() },
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
 * Page-story coverage for the PR's Preview tab - the fixed-viewport "control room" redesign. Renders
 * the real route tree end to end (shared PR header + tab bar, resource rail, app inspector, logs,
 * deployment rail) with no backend involved.
 */
const meta = {
  title: "Pages/PRPreviewTab",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(previewTabFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const BuildFailed: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/preview` },
};
