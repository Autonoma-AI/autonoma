import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const BUILD_STARTED_AT = new Date("2026-01-01T11:27:14.000Z");
const BUILD_FINISHED_AT = new Date("2026-01-01T11:28:20.000Z");
const ENVIRONMENT_ID = "env_fixture_main_01";
const HEAD_SHA = "a22387c9d4e1f6b8a0c3d5e7f9012345678901ab";

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
    branch: "main",
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
  dependencyService({ name: "db", kind: "database", iconKey: "postgres", endpoint: "db.main.internal:5432" }),
];

/**
 * The main branch's own preview environment (the repository's PR #0) - a failed build, so the
 * environment summary strip's Test User half renders `TestUserCardUnavailable` and no
 * `testUserOptions`/`testUserProvision` fixtures are needed.
 */
function previewkitSummary() {
  return {
    source: "previewkit" as const,
    environmentId: ENVIRONMENT_ID,
    repoFullName: "acme/acme-web",
    prNumber: 0,
    branch: "main",
    status: "failed" as const,
    primaryUrl: null,
    phase: "build_failed",
    error: "All app builds failed; see per-app build outcomes for details.",
    headSha: HEAD_SHA,
    lastDeployedSha: HEAD_SHA,
    updatedAt: BUILD_FINISHED_AT,
    deployedAt: BUILD_FINISHED_AT,
    serviceCount: PREVIEW_SERVICES.length,
    readyServiceCount: 1,
    degradedServiceCount: 0,
    failedServiceCount: 2,
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
 * Page fixtures for the main-branch page. No checkpoints yet (empty `snapshotHistory`) so
 * `MainBranchContent` renders its cheap empty state - unrelated to the preview section this story
 * targets. The preview section itself shows a failed build to exercise the environment summary
 * strip + compact app detail + logs, same shared components as the PR Preview tab.
 */
const mainBranchPageFixtures: TrpcFixtures = {
  branches: {
    list: [],
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
    pipelineStatusByBranchId: { kind: "none" },
  },
  bugs: { listSummary: [], listByBranch: [] },
  onboarding: { getState: completedOnboardingState() },
  deployments: {
    previewSummaryByBranchId: previewkitSummary(),
    previewSummaryById: previewkitSummary(),
    history: [
      {
        id: "build_fixture_main_01",
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
 * Page-story coverage for the main-branch page's embedded preview section - the same
 * EnvironmentSummaryStrip + PreviewEnvironmentExplorer the PR Preview tab uses, rendered inside
 * main.tsx's normal scrolling layout instead of the tab's fixed viewport.
 */
const meta = {
  title: "Pages/MainBranchPage",
  component: PageStory,
  parameters: { pageStory: true, msw: { handlers: appShellHandlers(mainBranchPageFixtures) } },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/main` },
};
