import type { CheckpointPresentationSummary } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { dashboardHandlers } from "lib/storybook/dashboard-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { RouterOutputs } from "lib/trpc";

/**
 * The pull request list - the one surface that lists pull requests, after Home and Preview Environments were
 * folded into it.
 *
 * Storied for three things: the paging (an application with hundreds of open PRs shows 25 and reports the true
 * total), the status vocabulary (every state a reader has to tell apart, in one frame), and where the unresolved
 * problems on main are shown.
 */

type BranchRow = RouterOutputs["branches"]["list"]["items"][number];

const BASE = `/app/${baseApplication.slug}/pull-requests`;

const BRANCHES = [
  { name: "feat/statements-export", title: "Export statements as CSV from the account page", author: "jrivera" },
  { name: "chore/bump-deps", title: "Bump the all-dependencies group across 1 directory", author: "amoreno" },
  { name: "fix/ledger-rounding", title: "Round ledger balances half-up to match the bank", author: "tcastro" },
  { name: "feat/bulk-transfer-import", title: "Import bulk transfers from a signed CSV", author: "lweiss" },
  { name: "refactor/external-transfer", title: "Consolidate the two external-transfer code paths", author: "jrivera" },
];

const PREVIEW_HOSTS = ["pr-4187", "pr-4186", "pr-4185", "pr-4184"];

/**
 * The verdicts the server can actually emit, with the two longest labels it has - "Checkpoint failed" and "No
 * tests affected" at 17 characters - and the longest reason. The Health column is sized to fit exactly these, so
 * a story that used shorter invented labels would photograph a fit that does not hold in production.
 */
const SUMMARIES: CheckpointPresentationSummary[] = [
  {
    tone: "success",
    label: "Passing",
    executionState: "passed",
    testCounts: { assigned: 6, run: 6, passed: 6, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    analysis: { jobStatus: "completed", bugCount: 0, passedCount: 6, coverageCount: 0 },
  },
  {
    tone: "critical",
    label: "2 bugs",
    reason: "5 occurrences",
    executionState: "failed",
    testCounts: { assigned: 8, run: 8, passed: 6, failed: 2, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    analysis: { jobStatus: "completed", bugCount: 2, passedCount: 6, coverageCount: 0 },
  },
  {
    tone: "critical",
    label: "Checkpoint failed",
    reason: "pipeline error",
    executionState: "pipeline_failed",
    testCounts: { assigned: 0, run: 0, passed: 0, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    analysis: { jobStatus: "failed", bugCount: 0, passedCount: 0, coverageCount: 0 },
  },
  {
    tone: "warning",
    label: "Not confirmed",
    reason: "12 couldn't confirm",
    executionState: "not_started",
    testCounts: { assigned: 14, run: 14, passed: 2, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    analysis: { jobStatus: "completed", bugCount: 0, passedCount: 2, coverageCount: 12 },
  },
  {
    tone: "neutral",
    label: "No tests affected",
    executionState: "not_started",
    testCounts: { assigned: 0, run: 0, passed: 0, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    analysis: { jobStatus: "completed", bugCount: 0, passedCount: 0, coverageCount: 0 },
  },
];

/** Every state the pipeline can be in, so one frame proves the list and the PR page agree about all of them. */
const STATUSES: BranchRow["prStatus"][] = [
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "checkpoint", summary: SUMMARIES[1]! },
  { kind: "checkpoint", summary: SUMMARIES[2]! },
  { kind: "checkpoint", summary: SUMMARIES[3]! },
  { kind: "checkpoint", summary: SUMMARIES[4]! },
  { kind: "building" },
  { kind: "pending_checks" },
  { kind: "analyzing" },
  { kind: "analysis_failed" },
  { kind: "build_failed" },
  { kind: "none" },
];

/**
 * The distribution a real application produces: mostly settled or in flight, with the occasional finding. One
 * in twelve rows has bugs and one in twelve could not be confirmed, which is roughly what the suites we run see.
 */
const REALISTIC_STATUSES: BranchRow["prStatus"][] = [
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "building" },
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "checkpoint", summary: SUMMARIES[1]! },
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "analyzing" },
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "checkpoint", summary: SUMMARIES[4]! },
  { kind: "checkpoint", summary: SUMMARIES[0]! },
  { kind: "checkpoint", summary: SUMMARIES[3]! },
  { kind: "pending_checks" },
];

function activeSnapshot(index: number, summary?: CheckpointPresentationSummary): BranchRow["activeSnapshot"] {
  return {
    id: `snapshot_pr_${index}`,
    status: "active",
    _count: { testCaseAssignments: 3 + (index % 9) },
    health: summary?.tone === "critical" ? "critical" : "healthy",
    summary,
  };
}

function row(index: number, state: "open" | "merged" | "closed" = "open"): BranchRow {
  const branch = BRANCHES[index % BRANCHES.length]!;
  const prNumber = 4187 - index;
  const status = STATUSES[index % STATUSES.length]!;
  // Not every pull request has a preview: some are still building, some never got one. The column has to read
  // as "nothing here" rather than as a missing value, so a third of the rows leave it empty.
  const previewHost = index % 3 === 2 ? undefined : PREVIEW_HOSTS[index % PREVIEW_HOSTS.length];
  return {
    id: `branch_pr_${prNumber}`,
    name: branch.name,
    createdAt: new Date(Date.UTC(2026, 6, 12, 8, 30)),
    prNumber,
    pr: {
      title: branch.title,
      state,
      authorLogin: branch.author,
      updatedAt: new Date(Date.UTC(2026, 7, 3, 23 - (index % 20), 40)),
    },
    previewUrl: previewHost != null ? `https://${previewHost}.preview.acme.example.com` : undefined,
    prStatus: status,
    activeSnapshot: activeSnapshot(index, status.kind === "checkpoint" ? status.summary : undefined),
  };
}

const PAGE_ONE = branchPage(Array.from({ length: 25 }, (_, index) => row(index)));

/** Every preview state the badge can show, keyed by the URLs the rows carry. */
const LIVENESS: RouterOutputs["previewAccess"]["livenessForApplication"] = {
  "https://pr-4187.preview.acme.example.com": "healthy",
  "https://pr-4186.preview.acme.example.com": "asleep",
  "https://pr-4185.preview.acme.example.com": "error",
  "https://pr-4184.preview.acme.example.com": "waking",
};

function listHandlers(list: RouterOutputs["branches"]["list"]) {
  return dashboardHandlers({
    branches: { list, snapshotHistory: [] },
    previewAccess: { livenessForApplication: LIVENESS },
  });
}

const meta = {
  title: "Pages/PullRequests",
  component: PageStory,
  parameters: {
    pageStory: true,
    layout: "fullscreen",
    msw: { handlers: listHandlers({ ...PAGE_ONE, totalCount: 292 }) },
  },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/** 292 open pull requests - sandstone's real order of magnitude - paged 25 at a time. */
export const ManyPullRequests: Story = {
  args: { path: `${BASE}?state=open` },
};

/**
 * What a page actually looks like most days, and the case the Health column is designed around: nearly every
 * pull request is passing or still building, and the two the reader has to do something about are the only
 * filled boxes on the screen.
 *
 * `ManyPullRequests` cycles all eleven states so every one gets exercised, which makes it a far more alarming
 * page than any real application produces. Both are worth having; this is the one to judge the design on.
 */
export const RealisticMix: Story = {
  args: { path: `${BASE}?state=open` },
  parameters: {
    msw: {
      handlers: listHandlers({
        ...branchPage(
          Array.from({ length: 25 }, (_, index) => {
            const base = row(index);
            return { ...base, prStatus: REALISTIC_STATUSES[index % REALISTIC_STATUSES.length]! };
          }),
        ),
        totalCount: 292,
      }),
    },
  },
};

/**
 * The same page rendered from the application root, which is where Home used to live. Proves the redirect: every
 * link that pointed at `/app/$appSlug` still arrives somewhere, and arrives here.
 */
export const FromApplicationRoot: Story = {
  args: { path: `/app/${baseApplication.slug}` },
};

/** A short list: the pager hides itself rather than rendering a lone, dead "1". */
export const SinglePage: Story = {
  args: { path: `${BASE}?state=open` },
  parameters: { msw: { handlers: listHandlers(branchPage(Array.from({ length: 4 }, (_, index) => row(index)))) } },
};

/**
 * Every verdict the server can emit, one per row, in one frame. This is the story that proves a single status
 * vocabulary: each of these renders through the same pill the PR page header and the main-branch chip use.
 *
 * It is also the truncation regression guard - rows 3 and 5 carry the longest labels the server has, and row 4
 * pairs a long label with a long reason.
 */
export const HealthVocabulary: Story = {
  args: { path: `${BASE}?state=open` },
  parameters: {
    msw: { handlers: listHandlers(branchPage(STATUSES.map((_, index) => row(index)))) },
  },
};

/** Merged pull requests keep their verdict and, while the environment is still up, their preview. */
export const Merged: Story = {
  args: { path: `${BASE}?state=merged` },
  parameters: {
    msw: {
      handlers: listHandlers(branchPage(Array.from({ length: 6 }, (_, index) => row(index, "merged")))),
    },
  },
};

/** Nothing to show: the guidance is written for the tab you are on rather than for "open" everywhere. */
export const Empty: Story = {
  args: { path: `${BASE}?state=closed` },
  parameters: { msw: { handlers: listHandlers(branchPage([])) } },
};

/**
 * The suite-health card beside the heading, and main's open problems in the standing rail.
 *
 * Both used to be somewhere else: health was a pair of bars in the top bar whose rank and run counts could
 * only be reached by hovering, and main was a chip in this heading. The chip is gone, so the rail is not
 * optional any more - its footer is the way through to the main-branch page.
 */
export const HealthAndMainRail: Story = {
  args: { path: `${BASE}?state=open` },
};
