import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const LAST_SEEN = new Date("2026-01-05T10:30:00.000Z");
const SNAPSHOT_ID = "snapshot_fixture_01";

const PAGED_BRANCH_NAMES = [
  "feat/statements-export",
  "chore/bump-deps",
  "fix/ledger-rounding",
  "feat/bulk-transfer-import",
  "refactor/consolidate-external-transfer",
];
const PAGED_TITLES = [
  "Export statements as CSV from the account page",
  "Bump the all-dependencies group across 1 directory",
  "Round ledger balances half-up to match the bank",
  "Import bulk transfers from a signed CSV",
  "Consolidate the two external-transfer code paths",
];
const PAGED_AUTHORS = ["jrivera", "amoreno", "tcastro", "lweiss"];

/**
 * Page fixtures for the app dashboard: an active snapshot with a few test
 * cases, two unresolved problems on main, and a completed onboarding. Every
 * literal typechecks against `RouterOutputs`, so these rot loudly when the API
 * shape changes.
 */
export const dashboardFixtures: TrpcFixtures = {
  branches: {
    list: branchPage(),
    // An application whose main has not run analysis: the rail keeps presenting its legacy `Bug` rows.
    mainOpenProblems: {
      source: "legacy_bug",
      problems: [
        {
          id: "bug_fixture_01",
          title: "Checkout button unresponsive after coupon removal",
          kind: "bug",
          severity: "high",
          detail: "Removing a coupon leaves the checkout button disabled until the page is reloaded.",
          occurrences: 3,
          lastSeenAt: LAST_SEEN,
        },
        {
          id: "bug_fixture_02",
          title: "Profile avatar upload silently fails on PNG over 5MB",
          kind: "bug",
          severity: "medium",
          detail: "The upload dialog closes as if it succeeded and the old avatar is still shown.",
          occurrences: 1,
          lastSeenAt: LAST_SEEN,
        },
      ],
    },
    detailByName: {
      id: baseApplication.mainBranchId ?? "branch_fixture_01",
      name: "main",
      pendingSnapshotId: null,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      activeSnapshot: {
        id: SNAPSHOT_ID,
        status: "active",
        createdAt: FIXTURE_EPOCH,
        source: "MANUAL",
        testCaseAssignments: [
          makeAssignment("01", "Login with valid credentials", "login-with-valid-credentials"),
          makeAssignment("02", "Create a new project", "create-a-new-project"),
          makeAssignment("03", "Invite a teammate", "invite-a-teammate"),
        ],
      },
    },
  },
  onboarding: {
    getState: makeCompletedOnboardingState(),
  },
};

function makeAssignment(suffix: string, name: string, slug: string) {
  return {
    id: `assignment_fixture_${suffix}`,
    testCaseId: `testcase_fixture_${suffix}`,
    testCase: { id: `testcase_fixture_${suffix}`, name, slug, folderId: "folder_fixture_01" },
    plan: { id: `plan_fixture_${suffix}` },
    stepsId: `steps_fixture_${suffix}`,
  };
}

function makeCompletedOnboardingState() {
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
 * Flagship page-story example: renders the real app dashboard through the
 * real route tree, with every API call answered by MSW fixtures - no
 * backend, database, or onboarding involved.
 */
const meta = {
  title: "Pages/AppHome",
  component: PageStory,
  parameters: {
    pageStory: true,
    msw: { handlers: appShellHandlers(dashboardFixtures) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { path: `/app/${baseApplication.slug}` },
};

/** One page of a long list, so the pager is exercised rather than hidden by a short fixture. */
const PAGED_PRS = branchPage(
  Array.from({ length: 25 }, (_, index) => {
    const prNumber = 4187 - index;
    return {
      id: `branch_page_${prNumber}`,
      name: PAGED_BRANCH_NAMES[index % PAGED_BRANCH_NAMES.length]!,
      createdAt: new Date(Date.UTC(2026, 6, 31 - (index % 28), 9, 12)),
      prNumber,
      pr: {
        title: PAGED_TITLES[index % PAGED_TITLES.length]!,
        state: "open" as const,
        authorLogin: PAGED_AUTHORS[index % PAGED_AUTHORS.length]!,
        updatedAt: new Date(Date.UTC(2026, 7, 3, 23 - index, 40)),
      },
      bugCount: index % 5 === 0 ? 1 : 0,
      previewUrl: undefined,
      prStatus: { kind: "pending_checks" as const },
      activeSnapshot: null,
    };
  }),
);

/**
 * An application with far more open pull requests than fit on a page - sandstone has ~290. The list shows the 25
 * most recently updated and pages through the rest; the header keeps reporting the true total.
 */
export const ManyPullRequests: Story = {
  args: { path: `/app/${baseApplication.slug}` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...dashboardFixtures,
        branches: { ...dashboardFixtures.branches, list: { ...PAGED_PRS, totalCount: 292 } },
      }),
    },
  },
};

/**
 * The previewkit side is live but the three deepening steps (SDK, artifacts, dry run) are not done.
 * Home renders its pull requests and problems like any other app; the sidebar's "Finish setup" entry
 * is what carries the outstanding work.
 */
export const SetupIncomplete: Story = {
  args: { path: `/app/${baseApplication.slug}` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...dashboardFixtures,
        branches: { ...dashboardFixtures.branches, list: PAGED_PRS },
        onboarding: { getState: makeUnfinishedOnboardingState() },
      }),
    },
  },
};

function makeUnfinishedOnboardingState() {
  return {
    ...makeCompletedOnboardingState(),
    lastDiscoveredAt: null,
    lastDiscoveredModels: null,
    dryRunPassedAt: null,
    sdkConfigured: false,
    dryRunPassed: false,
    artifactsUploaded: false,
    hasContent: false,
    setupComplete: false,
  };
}
