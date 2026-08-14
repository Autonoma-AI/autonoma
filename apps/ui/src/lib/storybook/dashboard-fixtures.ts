import type { CheckpointPresentationSummary } from "@autonoma/types";
import { appShellHandlers, baseApplication, branchPage } from "./base-fixtures";
import type { TrpcFixtures } from "./trpc-handler";

/**
 * The fixture every application-scoped page story builds on: a main branch with an active snapshot, two
 * unresolved problems on it, a completed onboarding, and an empty pull request list for the page to fill in.
 *
 * It lives here rather than beside one page's stories so that no story file has to import another's. Every
 * literal typechecks against `RouterOutputs`, so these rot loudly when the API shape changes.
 */

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const LAST_SEEN = new Date("2026-01-05T10:30:00.000Z");
const SNAPSHOT_ID = "snapshot_fixture_01";

/** Main is green: what the chip beside the pull request list shows when nothing is wrong with the branch. */
const MAIN_SUMMARY: CheckpointPresentationSummary = {
    tone: "success",
    label: "Passing",
    executionState: "passed",
    testCounts: { assigned: 3, run: 3, passed: 3, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    analysis: { jobStatus: "completed", bugCount: 0, passedCount: 3, coverageCount: 0 },
};

export const dashboardFixtures: TrpcFixtures = {
    branches: {
        list: branchPage(),
        // An application whose main has not run analysis: the rail keeps presenting its legacy `Bug` rows.
        mainOpenProblems: [
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
        pipelineStatusByBranchId: { kind: "checkpoint", summary: MAIN_SUMMARY },
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

/** The baseline handlers with the dashboard fixtures already merged in - what most page stories want. */
export function dashboardHandlers(overrides: TrpcFixtures = {}, { role }: { role?: string } = {}) {
    return appShellHandlers(
        {
            ...dashboardFixtures,
            ...overrides,
            branches: { ...dashboardFixtures.branches, ...overrides.branches },
        },
        { role },
    );
}

function makeAssignment(suffix: string, name: string, slug: string) {
    return {
        id: `assignment_fixture_${suffix}`,
        testCaseId: `testcase_fixture_${suffix}`,
        testCase: { id: `testcase_fixture_${suffix}`, name, slug, folderId: "folder_fixture_01" },
        plan: { id: `plan_fixture_${suffix}` },
    };
}

export function makeCompletedOnboardingState() {
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

/** The previewkit side is live but the three deepening steps (SDK, artifacts, dry run) are outstanding. */
export function makeUnfinishedOnboardingState() {
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
