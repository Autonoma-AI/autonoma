import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";
import { dashboardFixtures } from "./app-home.stories";

/**
 * The Pull Requests tab. Storied for the paging: an application with hundreds of open pull requests shows the 25
 * most recently updated and pages through the rest, and the header keeps reporting the true total rather than the
 * number of rows on screen.
 */

type BranchRow = RouterOutputs["branches"]["list"]["items"][number];

const BRANCHES = [
  { name: "feat/statements-export", title: "Export statements as CSV from the account page", author: "jrivera" },
  { name: "chore/bump-deps", title: "Bump the all-dependencies group across 1 directory", author: "amoreno" },
  { name: "fix/ledger-rounding", title: "Round ledger balances half-up to match the bank", author: "tcastro" },
  { name: "feat/bulk-transfer-import", title: "Import bulk transfers from a signed CSV", author: "lweiss" },
  { name: "refactor/external-transfer", title: "Consolidate the two external-transfer code paths", author: "jrivera" },
];

/** Cycled so the Health column shows every state a reader has to tell apart, not one repeated pill. */
const STATUSES: BranchRow["prStatus"][] = [
  { kind: "pending_checks" },
  { kind: "analyzing" },
  { kind: "building" },
  { kind: "analysis_failed" },
  { kind: "build_failed" },
];

function row(index: number): BranchRow {
  const branch = BRANCHES[index % BRANCHES.length]!;
  const prNumber = 4187 - index;
  return {
    id: `branch_pr_${prNumber}`,
    name: branch.name,
    createdAt: new Date(Date.UTC(2026, 6, 12, 8, 30)),
    prNumber,
    pr: {
      title: branch.title,
      state: "open",
      authorLogin: branch.author,
      updatedAt: new Date(Date.UTC(2026, 7, 3, 23 - index, 40)),
    },
    bugCount: index % 4 === 0 ? 1 : 0,
    previewUrl: undefined,
    prStatus: STATUSES[index % STATUSES.length]!,
    activeSnapshot: null,
  };
}

const PAGE_ONE = branchPage(Array.from({ length: 25 }, (_, index) => row(index)));

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

/** The header's main-branch chip reads this on every render of the tab. */
const MAIN_BRANCH: RouterOutputs["branches"]["detailByName"] = {
  id: baseApplication.mainBranchId ?? "branch_fixture_01",
  name: "main",
  pendingSnapshotId: null,
  createdAt: FIXTURE_EPOCH,
  updatedAt: FIXTURE_EPOCH,
  activeSnapshot: {
    id: "snapshot_fixture_01",
    status: "active",
    source: "MANUAL",
    createdAt: FIXTURE_EPOCH,
    testCaseAssignments: [],
  },
};

const meta = {
  title: "Pages/PullRequests",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen" },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 292 open pull requests - sandstone's real order of magnitude - paged 25 at a time. */
export const ManyPullRequests: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests?state=open` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...dashboardFixtures,
        branches: {
          ...dashboardFixtures.branches,
          list: { ...PAGE_ONE, totalCount: 292 },
          detailByName: MAIN_BRANCH,
          snapshotHistory: [],
        },
      }),
    },
  },
};

/** A short list: the pager hides itself rather than rendering a lone, dead "1". */
export const SinglePage: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests?state=open` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...dashboardFixtures,
        branches: {
          ...dashboardFixtures.branches,
          list: branchPage(Array.from({ length: 4 }, (_, index) => row(index))),
          detailByName: MAIN_BRANCH,
          snapshotHistory: [],
        },
      }),
    },
  },
};
