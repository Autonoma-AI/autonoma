import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const PRICING_SYNCED_AT = new Date("2026-01-27T03:00:00.000Z");
const PR_NUMBER = 2624;
const ENVIRONMENT_ID = "env_fixture_01";
const BRANCH_ID = "branch_fixture_pr_01";
const BRANCH_NAME = "eng-1665-make-the-search-icon-clickable-for-the-search-widget";
const HEAD_SHA = "a22387c9d4e1f6b8a0c3d5e7f9012345678901ab";
const BASE_SHA = "9f1c2d3e4b5a6f708192a3b4c5d6e7f809182736";
const PR_TITLE = "Make the search icon clickable for the search widget";
const USAGE_PATH = `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/usage`;

/**
 * A previewkit-hosted environment, ready - `source: "previewkit"` is what makes the tab render the
 * compute-usage panel at all (an off-platform preview has no environment to meter).
 */
function previewkitSummary() {
  return {
    source: "previewkit" as const,
    environmentId: ENVIRONMENT_ID,
    repoFullName: "acme/acme-web",
    prNumber: PR_NUMBER,
    branch: BRANCH_NAME,
    status: "ready" as const,
    primaryUrl: "https://web-app.preview-2624.internal",
    sdkAppUrl: null,
    sdkPath: null,
    phase: "ready",
    error: null,
    headSha: HEAD_SHA,
    lastDeployedSha: HEAD_SHA,
    updatedAt: FIXTURE_EPOCH,
    deployedAt: FIXTURE_EPOCH,
    serviceCount: 0,
    readyServiceCount: 0,
    degradedServiceCount: 0,
    failedServiceCount: 0,
    services: [],
    latestBuild: null,
    actions: {
      openPreview: { enabled: true, href: "https://web-app.preview-2624.internal", reason: null },
    },
  };
}

/** Everything the app shell and the PR-page header need, identical across every story here. */
const SHARED_FIXTURES: TrpcFixtures = {
  branches: {
    list: branchPage(),
    snapshotHistory: [],
    // The app shell resolves the app's main branch on every page under it, PR tabs included.
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
      id: BRANCH_ID,
      name: BRANCH_NAME,
      createdAt: FIXTURE_EPOCH,
      updatedAt: FIXTURE_EPOCH,
      prNumber: PR_NUMBER,
      prTitle: PR_TITLE,
    },
    pipelineStatusByBranchId: { kind: "none" },
  },
  deployments: {
    previewSummaryByPr: previewkitSummary(),
    previewSummaryById: previewkitSummary(),
    history: [],
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
      title: PR_TITLE,
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
};

/**
 * The AWS-derived reference rate the weekly drift cronjob keeps current. Buildkit carries a real
 * spot fraction (it is the only spot-eligible pool); previewkit is on-demand-only, so its
 * `spotFraction`/`sampleSize` are null and the panel omits the spot clause for that row.
 */
const PRICING_REFERENCE = [
  {
    pool: "buildkit",
    usdPerVcpuHour: 0.02772,
    usdPerGbHour: 0.00315,
    spotFraction: 0.62,
    sampleSize: 148,
    updatedAt: PRICING_SYNCED_AT,
  },
  {
    pool: "previewkit",
    usdPerVcpuHour: 0.03465,
    usdPerGbHour: 0.0039375,
    spotFraction: null,
    sampleSize: null,
    updatedAt: PRICING_SYNCED_AT,
  },
];

/** Metered compute for the environment, priced at a live (non-zero) rate. */
const COMPUTE_USAGE = {
  build: { vcpuSeconds: 167.78, gbSeconds: 671.12, buildCount: 2, credits: 2.4235 },
  running: { vcpuSeconds: 1843.2, gbSeconds: 7372.8, windowCount: 4, credits: 26.6222 },
  // The org that OWNS the environment - what the rate form writes back to, deliberately not
  // whichever org the viewing admin happens to be switched into.
  organizationId: "org_fixture_01",
  organizationName: "Acme",
  creditsPerVcpuHour: 52,
  creditsPerGbMemoryHour: 6,
};

const AI_COST = {
  totalCalls: 21,
  totalCostMicrodollars: 94_700,
  byTag: [{ tag: "analysis-impact", calls: 21, costMicrodollars: 94_700, inputTokens: 412_880, outputTokens: 9_004 }],
};

const ADMIN_FIXTURES: TrpcFixtures = {
  ...SHARED_FIXTURES,
  admin: {
    usage: { branchAiCost: AI_COST, environmentComputeUsage: COMPUTE_USAGE },
    billing: { getComputePricingReference: PRICING_REFERENCE },
  },
};

const meta = {
  title: "Pages/PrUsageTab",
  component: PageStory,
  parameters: { pageStory: true, layout: "fullscreen" },
} satisfies Meta<typeof PageStory>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The tab as staff see it: AI cost by tag, metered build/running compute, the AWS reference rate,
 * and the form that sets the environment owner's billed rate. The rate is live here (52/6), so the
 * credits columns show real charges rather than the shadow-mode zeros.
 */
export const Admin: Story = {
  parameters: { msw: { handlers: appShellHandlers(ADMIN_FIXTURES, { role: "admin" }) } },
  args: { path: USAGE_PATH },
};

/**
 * Shadow mode - the rate is still zeroed, which is every org's default until an admin deliberately
 * sets one. Usage is measured identically; only the credits price out to zero, and the panel says so
 * rather than letting a reader mistake it for free compute.
 */
export const AdminShadowMode: Story = {
  parameters: {
    msw: {
      handlers: appShellHandlers(
        {
          ...SHARED_FIXTURES,
          admin: {
            usage: {
              branchAiCost: AI_COST,
              environmentComputeUsage: {
                ...COMPUTE_USAGE,
                build: { ...COMPUTE_USAGE.build, credits: 0 },
                running: { ...COMPUTE_USAGE.running, credits: 0 },
                creditsPerVcpuHour: 0,
                creditsPerGbMemoryHour: 0,
              },
            },
            // The drift cronjob has never run in this environment, so there is no reference to
            // compare the billed rate against - the state every org starts in.
            billing: { getComputePricingReference: [] },
          },
        },
        { role: "admin" },
      ),
    },
  },
  args: { path: USAGE_PATH },
};

/**
 * Nothing metered yet - a PR whose preview came up but has not built or run long enough to close a
 * usage window, and whose analysis has made no AI calls. Exercises the zero rows rather than an
 * error or a blank panel.
 */
export const AdminEmpty: Story = {
  parameters: {
    msw: {
      handlers: appShellHandlers(
        {
          ...SHARED_FIXTURES,
          admin: {
            usage: {
              branchAiCost: { totalCalls: 0, totalCostMicrodollars: 0, byTag: [] },
              environmentComputeUsage: {
                ...COMPUTE_USAGE,
                build: { vcpuSeconds: 0, gbSeconds: 0, buildCount: 0, credits: 0 },
                running: { vcpuSeconds: 0, gbSeconds: 0, windowCount: 0, credits: 0 },
              },
            },
            billing: { getComputePricingReference: PRICING_REFERENCE },
          },
        },
        { role: "admin" },
      ),
    },
  },
  args: { path: USAGE_PATH },
};

/**
 * A non-admin who reaches the URL directly - a stale bookmark, or an account that has since lost
 * admin. `pr-tabs.tsx` never links here for them, so this is the route's own guard: a restricted
 * message instead of a FORBIDDEN error bubbling out of the admin-only queries underneath. No `admin`
 * fixtures are supplied on purpose, proving the guard short-circuits before any of them is called.
 */
export const NotAdmin: Story = {
  parameters: { msw: { handlers: appShellHandlers(SHARED_FIXTURES) } },
  args: { path: USAGE_PATH },
};
