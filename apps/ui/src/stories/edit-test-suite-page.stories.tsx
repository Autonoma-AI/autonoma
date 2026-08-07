import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, completedOnboardingState } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import type { RouterOutputs } from "lib/trpc";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

function editPageFixtures(state: RouterOutputs["snapshotEdit"]["state"]): TrpcFixtures {
  return {
    branches: {
      detailByName: {
        id: baseApplication.mainBranchId ?? "branch_fixture_01",
        name: "main",
        pendingSnapshotId: state.state === "open" ? state.snapshotId : "snapshot_fixture_analysis",
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
    onboarding: { getState: completedOnboardingState() },
    snapshotEdit: { state },
  };
}

const meta = {
  title: "Pages/EditTestSuitePage",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The branch is free: the editor offers to open a session. */
export const NoSession: Story = {
  args: { path: "/app/acme-web/edit" },
  parameters: { msw: { handlers: appShellHandlers(editPageFixtures({ state: "none" })) } },
};

/**
 * A push took the branch's single pending-snapshot slot. The editor refuses to render rather than showing the
 * analysis run's authored tests as the user's own pending edits.
 */
export const AnalysisInFlight: Story = {
  args: { path: "/app/acme-web/edit" },
  parameters: { msw: { handlers: appShellHandlers(editPageFixtures({ state: "analysis-in-flight" })) } },
};
