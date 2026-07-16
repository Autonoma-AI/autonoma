import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const LAST_SEEN = new Date("2026-01-05T10:30:00.000Z");
const SNAPSHOT_ID = "snapshot_fixture_01";

/**
 * Page fixtures for the app dashboard: an active snapshot with a few test
 * cases, two open bugs, and a completed onboarding. Every literal typechecks
 * against `RouterOutputs`, so these rot loudly when the API shape changes.
 */
const dashboardFixtures: TrpcFixtures = {
  branches: {
    list: [],
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
  bugs: {
    listSummary: [
      {
        id: "bug_fixture_01",
        status: "open",
        title: "Checkout button unresponsive after coupon removal",
        severity: "high",
        lastSeenAt: LAST_SEEN,
        occurrences: 3,
      },
      {
        id: "bug_fixture_02",
        status: "open",
        title: "Profile avatar upload silently fails on PNG over 5MB",
        severity: "medium",
        lastSeenAt: LAST_SEEN,
        occurrences: 1,
      },
    ],
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
