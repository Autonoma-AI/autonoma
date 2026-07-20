import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const RUN_AT = new Date("2026-01-01T11:24:00.000Z");
const PREV_RUN_AT = new Date("2026-01-01T09:12:00.000Z");
const STARTED_AT = new Date("2026-01-01T11:20:00.000Z");
const COMPLETED_AT = new Date("2026-01-01T11:23:40.000Z");
const PR_NUMBER = 482;
const BRANCH_ID = "branch_pr482";
const BRANCH_NAME = "feat/checkout-rework";
const LATEST_SNAPSHOT_ID = "snap_pr482_auth_02";
const PREV_SNAPSHOT_ID = "snap_pr482_auth_01";
const HEAD_SHA = "b41d9c07e2f5a8c1d3e6f90a2b4c6d8e0f123456";
const BASE_SHA = "a13c8b06d1e4a7b0c2d5e8f9012a3b4c5d6e7f80";
const PREV_HEAD_SHA = "c52e0d18f3a6b9d2e4f7a01b3c5d7e9f10234567";

// The two-plane authoritative report: one client bug (the only actionable finding), two passed tests, and two
// non-blocking coverage findings (a scenario-data gap + an engine artifact), plus the impact-analysis and
// narration prose the linked snapshot page shows in full.
const analysisReport: NonNullable<TrpcFixtures["branches"]> = {
  analysisReport: {
    impactReasoning:
      "This PR reworks the checkout submit handler and the cart badge counter. I re-ran the two existing " +
      "checkout tests that exercise those surfaces and authored one new test for the guest add-to-cart path.",
    narration:
      "This checkpoint surfaced one client bug: on the checkout page the Place order button never enables even " +
      "once the form is valid, so a customer cannot complete a purchase. The cart and add-to-cart flows behaved " +
      "correctly. Two tests could not confirm app health this run - a coupon scenario was not seeded and the " +
      "payment iframe did not load in the harness - so neither counts against the PR.",
    findings: [
      {
        id: "checkout-place-order",
        slug: "checkout-place-order",
        category: "client_bug",
        headline: "Place order button never enables on the checkout page",
        confidence: "high",
        whatHappened:
          "With a valid saved card and a complete shipping address, every field validated but the Place order " +
          "button stayed disabled, so the run could never submit the order.",
        rootCause:
          "The submit handler reads a `formValid` flag computed once on mount and never recomputed after the " +
          "async address-validation promise resolves.",
        remediation: "Recompute form validity after the address-validation promise settles.",
        evidence: [{ source: "run", detail: "The Place order button kept aria-disabled after all fields were valid." }],
        stepCount: 14,
        runSuccess: false,
      },
      {
        id: "guest-add-to-cart",
        slug: "guest-add-to-cart",
        category: "passed",
        headline: "A guest can add items to the cart",
        confidence: "high",
        evidence: [],
        stepCount: 8,
        runSuccess: true,
      },
      {
        id: "cart-badge-count",
        slug: "cart-badge-count",
        category: "passed",
        headline: "The cart badge reflects the number of items",
        evidence: [],
        stepCount: 6,
        runSuccess: true,
      },
      {
        id: "coupon-apply",
        slug: "coupon-apply",
        category: "scenario_issue",
        headline: "Coupon test data was not seeded for this run",
        evidence: [],
      },
      {
        id: "payment-iframe",
        slug: "payment-iframe",
        category: "engine_artifact",
        headline: "The payment iframe did not load in the harness",
        evidence: [],
      },
    ],
  },
};

function snapshotHistoryItem(overrides: {
  id: string;
  headSha: string;
  createdAt: Date;
  prevSnapshotId: string | null;
  tone: "success" | "critical";
  label: string;
  bugCount: number;
  passing: number;
  failing: number;
}) {
  const totalTests = overrides.passing + overrides.failing;
  return {
    id: overrides.id,
    status: "active" as const,
    source: "GITHUB_PUSH" as const,
    headSha: overrides.headSha,
    baseSha: BASE_SHA,
    createdAt: overrides.createdAt,
    prevSnapshotId: overrides.prevSnapshotId,
    _count: { testCaseAssignments: totalTests },
    changeSummary: { added: 1, removed: 0, updated: 2 },
    health: overrides.tone === "critical" ? ("critical" as const) : ("healthy" as const),
    healthCounts: {
      failing: overrides.failing,
      passing: overrides.passing,
      running: 0,
      setupFailed: 0,
      notAffected: 0,
      totalTests,
    },
    bugCount: overrides.bugCount,
    summary: {
      tone: overrides.tone,
      label: overrides.label,
      executionState: (overrides.tone === "critical" ? "failed" : "passed") as "failed" | "passed",
      openBugCount: overrides.bugCount,
      issueOccurrenceCount: 0,
      testCounts: {
        assigned: totalTests,
        run: totalTests,
        passed: overrides.passing,
        failed: overrides.failing,
        setupFailed: 0,
        running: 0,
        notRun: 0,
      },
      failingByKind: { engine: 0, app: overrides.failing },
      suiteChangeCount: 3,
    },
  };
}

// Two checkpoints on the PR so the CHECKPOINT HISTORY rail shows a real timeline; the newest is the one whose
// findings the main column embeds.
const snapshotHistory: NonNullable<TrpcFixtures["branches"]>["snapshotHistory"] = [
  snapshotHistoryItem({
    id: LATEST_SNAPSHOT_ID,
    headSha: HEAD_SHA,
    createdAt: RUN_AT,
    prevSnapshotId: PREV_SNAPSHOT_ID,
    tone: "critical",
    label: "Needs attention",
    bugCount: 1,
    passing: 2,
    failing: 1,
  }),
  snapshotHistoryItem({
    id: PREV_SNAPSHOT_ID,
    headSha: PREV_HEAD_SHA,
    createdAt: PREV_RUN_AT,
    prevSnapshotId: null,
    tone: "success",
    label: "Healthy",
    bugCount: 0,
    passing: 3,
    failing: 0,
  }),
];

// Chrome the app shell + PR header/tab bar need on every PR page, independent of the checkpoint content.
const chromeFixtures: TrpcFixtures = {
  branches: {
    list: [],
    detailByName: {
      id: baseApplication.mainBranchId ?? "branch_fixture_01",
      name: "main",
      pendingSnapshotId: null,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      activeSnapshot: {
        id: "snapshot_main_01",
        status: "active",
        createdAt: FIXTURE_EPOCH,
        source: "MANUAL",
        testCaseAssignments: [],
      },
    },
    detailByPr: {
      id: BRANCH_ID,
      name: BRANCH_NAME,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      prNumber: PR_NUMBER,
      prTitle: "Rework the checkout submit flow",
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
      title: "Rework the checkout submit flow",
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
        message: "Recompute checkout form validity after address validation",
        authorLogin: "jrivera",
        authoredAt: RUN_AT.toISOString(),
      },
    ],
  },
  deployments: {
    previewSummaryByPr: {
      source: "none",
      status: "missing",
      primaryUrl: null,
      phase: null,
      error: "No preview environment for this PR.",
      headSha: HEAD_SHA,
      lastDeployedSha: null,
      updatedAt: null,
      deployedAt: null,
      serviceCount: 0,
      readyServiceCount: 0,
      degradedServiceCount: 0,
      failedServiceCount: 0,
      services: [],
      latestBuild: null,
      actions: { openPreview: { enabled: false, href: null, reason: "No preview URL is available." } },
    },
  },
  bugs: { listSummary: [] },
  onboarding: {
    getState: {
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
      lastDiscoveredAt: FIXTURE_EPOCH,
      lastDiscoveredModels: 12,
      discoveringStartedAt: null,
      dryRunPassedAt: FIXTURE_EPOCH,
      diffTriggerConfirmedAt: FIXTURE_EPOCH,
      agentHolder: "human",
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
    },
  },
};

function pageFixtures(branchOverrides: NonNullable<TrpcFixtures["branches"]>): TrpcFixtures {
  return {
    ...chromeFixtures,
    branches: { ...chromeFixtures.branches, snapshotHistory, ...branchOverrides },
  };
}

const meta = {
  title: "Pages/AuthoritativePRPage",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const OVERVIEW_PATH = `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}`;

/** The authoritative PR overview: verdict headline + the latest snapshot's findings list, with the history rail. */
export const Report: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        pageFixtures({
          ...analysisReport,
          analysisJob: { status: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT },
        }),
      ),
    },
  },
};

/** The running-snapshot fallback: an authoritative run is still in flight, so the AnalysisJob status stands in. */
export const Running: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        pageFixtures({
          analysisReport: null,
          analysisJob: { status: "running", startedAt: STARTED_AT },
        }),
      ),
    },
  },
};
