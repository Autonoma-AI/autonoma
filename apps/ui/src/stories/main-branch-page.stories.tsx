import type { AnalysisVerdictState } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  appShellHandlers,
  baseApplication,
  branchPage,
  completedOnboardingState,
  neverRunSuiteHealth,
  zeroActivity,
} from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const BUILD_STARTED_AT = new Date("2026-01-01T11:27:14.000Z");
const BUILD_FINISHED_AT = new Date("2026-01-01T11:28:20.000Z");
const ENVIRONMENT_ID = "env_fixture_main_01";
const HEAD_SHA = "a22387c9d4e1f6b8a0c3d5e7f9012345678901ab";
const BASE_SHA = "b1039fc2e5a7d9038f4c6b1a2d3e4f5061728394";
const BRANCH_ID = baseApplication.mainBranchId ?? "branch_fixture_01";
const LATEST_SNAPSHOT_ID = "snapshot_fixture_main_02";
const PREV_SNAPSHOT_ID = "snapshot_fixture_main_01";
const LATEST_RUN_AT = new Date("2026-01-05T09:12:00.000Z");
const PREV_RUN_AT = new Date("2026-01-03T16:40:00.000Z");
const PATH = `/app/${baseApplication.slug}/pull-requests/main`;

/** One checkpoint's per-bucket outcome - what the verdict and its badge copy are derived from. */
interface CheckpointCounts {
  bugCount: number;
  passed: number;
  coverage: number;
}

type Checkpoint = RouterOutputs["branches"]["snapshotHistory"][number];

type CheckpointVerdictPresentation = Pick<
  NonNullable<Checkpoint["summary"]>,
  "tone" | "label" | "reason" | "executionState"
> & { health: Checkpoint["health"] };

/** How each verdict state presents, mirroring the authoritative summary builder. Only a coverage gap gets a reason. */
const CHECKPOINT_VERDICT: Record<AnalysisVerdictState, (counts: CheckpointCounts) => CheckpointVerdictPresentation> = {
  bug_found: (counts) => ({
    tone: "critical",
    label: `${counts.bugCount} ${counts.bugCount === 1 ? "bug" : "bugs"}`,
    executionState: "failed",
    health: "critical",
  }),
  not_confirmed: (counts) => ({
    tone: "warning",
    label: "Not confirmed",
    reason: counts.passed === 0 ? `${counts.coverage} blocked` : `${counts.coverage} couldn't confirm`,
    executionState: "not_started",
    health: "unknown",
  }),
  no_tests_needed: () => ({
    tone: "success",
    label: "No tests needed",
    executionState: "passed",
    health: "healthy",
  }),
  healthy: () => ({ tone: "success", label: "Passing", executionState: "passed", health: "healthy" }),
};

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
    statusExplanation: null,
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
    statusExplanation: null,
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
 * selected app's URL row renders `TestUserButtonUnavailable` and no `testUserOptions` /
 * `testUserProvision` fixtures are needed.
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
    sdkAppUrl: null,
    sdkPath: null,
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

/**
 * Page fixtures for the main-branch page. No checkpoints yet (empty `snapshotHistory`) so
 * `MainBranchContent` renders its cheap empty state - unrelated to the preview section this story
 * targets. The preview section itself shows a failed build to exercise the environment summary
 * strip + compact app detail + logs, same shared components as the PR Preview tab.
 */
const mainBranchPageFixtures: TrpcFixtures = {
  branches: {
    list: branchPage(),
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
  args: { path: PATH },
};

/**
 * Main has never been checked - the zero reading of the checkpoint panel.
 *
 * One string used to cover this and the case below, which are opposite situations: a repository the agent has
 * never run against at all, and one whose runs have simply all been on pull-request branches. The first needs to
 * say what a checkpoint even is; the second only needs to say none has landed on main.
 */
export const NeverChecked: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...mainBranchPageFixtures,
        applications: { activity: zeroActivity(), suiteHealth: neverRunSuiteHealth() },
        branches: { ...mainBranchPageFixtures.branches, snapshotHistory: [], mainOpenProblems: [] },
      }),
    },
  },
};

/** The empty twin: runs have happened, none of them on main yet. Shot alongside `NeverChecked` on purpose. */
export const MainNeverMerged: Story = {
  args: { path: PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...mainBranchPageFixtures,
        branches: { ...mainBranchPageFixtures.branches, snapshotHistory: [], mainOpenProblems: [] },
      }),
    },
  },
};

/**
 * The problem list presents main's open `AnalysisIssue` rows - one bug, one environment problem, so the kind badge
 * renders on the non-bug row - beside a checkpoint rail reading the same authoritative verdict, so the red count
 * and the list under it agree.
 */
export const AnalyzedMain: Story = {
  args: { path: PATH },
  parameters: {
    pageStory: true,
    msw: {
      handlers: appShellHandlers({
        ...mainBranchPageFixtures,
        branches: {
          ...mainBranchPageFixtures.branches,
          snapshotHistory: [
            mainCheckpoint({
              id: LATEST_SNAPSHOT_ID,
              createdAt: LATEST_RUN_AT,
              state: "bug_found",
              bugCount: 1,
              passed: 3,
              coverage: 1,
            }),
            mainCheckpoint({
              id: PREV_SNAPSHOT_ID,
              createdAt: PREV_RUN_AT,
              state: "healthy",
              bugCount: 0,
              passed: 4,
              coverage: 0,
            }),
          ],
          snapshotDetail: mainSnapshotDetail(),
          mainOpenProblems: [
            {
              id: "issue_fixture_01",
              title: "Publishing an invoice leaves the supplier total stale",
              kind: "bug",
              severity: "high",
              detail:
                "After publishing, the supplier row still shows the pre-publish total until the page is reloaded.",
              occurrences: 3,
              lastSeenAt: LATEST_RUN_AT,
            },
            {
              id: "issue_fixture_02",
              title: "The preview's OCR service is unreachable during extraction",
              kind: "environment",
              severity: "medium",
              detail: "Extraction requests to the OCR service time out, so no test can reach the review step.",
              occurrences: 2,
              lastSeenAt: LATEST_RUN_AT,
            },
          ],
        },
      }),
    },
  },
};

/**
 * Every open problem on main is a `bug`, so no row carries a kind badge and the list is ordered purely by
 * descending severity - the counterpart to {@link AnalyzedMain}'s mixed-kind list.
 */
export const BugsOnlyOnMain: Story = {
  args: { path: PATH },
  parameters: {
    pageStory: true,
    msw: {
      handlers: appShellHandlers({
        ...mainBranchPageFixtures,
        branches: {
          ...mainBranchPageFixtures.branches,
          snapshotHistory: [
            mainCheckpoint({
              id: LATEST_SNAPSHOT_ID,
              createdAt: LATEST_RUN_AT,
              state: "bug_found",
              bugCount: 2,
              passed: 2,
              coverage: 0,
            }),
          ],
          snapshotDetail: mainSnapshotDetail(),
          mainOpenProblems: [
            {
              id: "bug_fixture_01",
              title: "Checkout button unresponsive after coupon removal",
              kind: "bug",
              severity: "critical",
              detail: "Removing a coupon leaves the checkout button disabled until the page is reloaded.",
              occurrences: 5,
              lastSeenAt: LATEST_RUN_AT,
            },
            {
              id: "bug_fixture_02",
              title: "Saved card is dropped when the billing address changes",
              kind: "bug",
              severity: "medium",
              detail: "The card selection resets to empty and the order cannot be completed without re-entering it.",
              occurrences: 2,
              lastSeenAt: PREV_RUN_AT,
            },
          ],
        },
      }),
    },
  },
};

/** One checkpoint on main, presented from its analysis verdict exactly as the API's authoritative arm builds it. */
function mainCheckpoint(overrides: {
  id: string;
  createdAt: Date;
  /** The verdict this checkpoint depicts. Stated, not derived: a story says which case it is showing. */
  state: AnalysisVerdictState;
  bugCount: number;
  passed: number;
  coverage: number;
}) {
  const totalTests = overrides.bugCount + overrides.passed + overrides.coverage;
  // The badge copy still routes through the shared per-state mapping, so a story cannot invent copy the API never renders.
  const verdict = CHECKPOINT_VERDICT[overrides.state](overrides);

  return {
    id: overrides.id,
    status: "active" as const,
    source: "GITHUB_PUSH" as const,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    createdAt: overrides.createdAt,
    prevSnapshotId: null,
    // These stories fixture the authoritative pipeline, which is what the overview gates on.
    analyzed: true,
    settled: true,
    _count: { testCaseAssignments: totalTests },
    changeSummary: { added: 0, removed: 0, updated: 1 },
    health: verdict.health,
    healthCounts: {
      failing: 0,
      passing: overrides.passed,
      running: 0,
      setupFailed: 0,
      notAffected: 0,
      totalTests,
    },
    summary: {
      tone: verdict.tone,
      label: verdict.label,
      reason: verdict.reason,
      executionState: verdict.executionState,
      testCounts: {
        assigned: totalTests,
        run: totalTests,
        passed: overrides.passed,
        failed: 0,
        setupFailed: 0,
        running: 0,
        notRun: 0,
      },
      suiteChangeCount: 1,
      analysis: {
        jobStatus: "completed" as const,
        bugCount: overrides.bugCount,
        passedCount: overrides.passed,
        coverageCount: overrides.coverage,
      },
    },
  };
}

/** The latest checkpoint's detail, for the "Latest checkpoint" test breakdown beside the problem list. */
function mainSnapshotDetail(): NonNullable<TrpcFixtures["branches"]>["snapshotDetail"] {
  return {
    snapshot: {
      id: LATEST_SNAPSHOT_ID,
      status: "active",
      source: "GITHUB_PUSH",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      createdAt: LATEST_RUN_AT,
      prevSnapshotId: null,
      branch: { id: BRANCH_ID, name: "main", applicationId: baseApplication.id, prNumber: undefined },
    },
    changes: [],
    createdTests: [],
    health: "critical",
    healthCounts: { failing: 0, passing: 3, running: 0, setupFailed: 0, notAffected: 0, totalTests: 5 },
    summary: {
      tone: "critical",
      label: "1 bug",
      executionState: "failed",
      testCounts: { assigned: 5, run: 5, passed: 3, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
      suiteChangeCount: 1,
      analysis: { jobStatus: "completed", bugCount: 1, passedCount: 3, coverageCount: 1 },
    },
    analyzed: true,
    settled: true,
    executedTests: [],
  };
}
