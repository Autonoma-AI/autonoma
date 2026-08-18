import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication, branchPage } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { within } from "storybook/test";
import { withRunSignals } from "./analysis-run-signals";

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

// An inline-SVG stand-in screenshot so the report's evidence token + the issue thumbnails render with no network.
const MOCK_SCREENSHOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='760' viewBox='0 0 1200 760'>
    <rect width='1200' height='760' fill='#f5f6f8'/>
    <rect x='360' y='120' width='480' height='520' rx='12' fill='#ffffff' stroke='#e2e5ea'/>
    <text x='400' y='184' font-family='sans-serif' font-size='24' font-weight='600' fill='#1f2430'>Checkout</text>
    <rect x='400' y='444' width='400' height='48' rx='8' fill='#c7ccd6'/>
    <text x='600' y='474' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='600' fill='#8a90a0'>Place order</text>
  </svg>`,
)}`;

// The Reporter's holistic report prose. Exercises every inline token: a link to a known issue (resolves), a link
// to a known finding (resolves), an evidence image backed by `reportEvidence`, and a fabricated issue reference
// (renders as plain text, not a dangling link).
const REPORT_MARKDOWN = [
  "## Checkout rework",
  "",
  "This PR introduces one blocking bug: the [Place order button never enables](issue:issue_place_order), so a " +
    "customer cannot complete a purchase. The run that surfaced it is [checkout-place-order](finding:checkout-place-order).",
  "",
  "![The disabled Place order button](evidence:asset_report_1)",
  "",
  "The cart and add-to-cart flows behaved correctly. A separate [coupon scenario gap](issue:issue_coupon) did not " +
    "block the PR, and a [ghost reference](issue:ghost_missing) resolves to nothing.",
  "",
  "An earlier [cart badge miscount](issue:issue_cart_badge) was fixed by the latest push and is now resolved.",
].join("\n");

// The Reporter's one-paragraph summary - the PR verdict subtitle, replacing the old generic policy sentence.
const REPORT_SUMMARY =
  "Checkout is broken on this PR: the Place order button never enables even with a valid card and address, so no " +
  "customer can complete a purchase. Cart and add-to-cart still work.";

// The branch's issues, bugs-first then by severity. The list + headline show only the OPEN ones; the resolved one
// is here so the prose's `issue:` token for it still links (a cross-snapshot reference, not a fabrication).
const analysisIssues: NonNullable<TrpcFixtures["branches"]>["analysisIssues"] = [
  {
    id: "issue_place_order",
    title: "Place order button never enables on checkout",
    kind: "bug",
    severity: "critical",
    status: "open",
    runCount: 2,
    thumbnailUrl: MOCK_SCREENSHOT,
  },
  {
    id: "issue_coupon",
    title: "Coupon scenario is not seeded",
    kind: "scenario",
    severity: "medium",
    status: "open",
    runCount: 1,
  },
  {
    id: "issue_cart_badge",
    title: "Cart badge miscounts items after removal",
    kind: "bug",
    severity: "high",
    status: "resolved",
    runCount: 3,
  },
];

// The two-plane authoritative report: the Reporter's prose hero + its findings. The PR page renders the prose and
// the open-issues list; the per-snapshot findings live on the linked snapshot page.
const analysisReport: NonNullable<TrpcFixtures["branches"]> = {
  analysisReport: {
    impactReasoning:
      "This PR reworks the checkout submit handler and the cart badge counter. I re-ran the two existing " +
      "checkout tests that exercise those surfaces and authored one new test for the guest add-to-cart path.",
    reportMarkdown: REPORT_MARKDOWN,
    title: "Checkout crashes on CSV export",
    headline: REPORT_SUMMARY,
    flows: [
      {
        title: "Guest checkout",
        detail: "Cart totals and the confirmation screen were confirmed end to end.",
        status: "verified" as const,
        owner: "none" as const,
        passedCount: 2,
        gapCount: 0,
        bugCount: 0,
        checkedThisRunCount: 2,
        testSlugs: ["checkout-guest", "checkout-confirm"],
      },
      {
        title: "Coupon codes",
        detail: "The coupon fixtures this flow needs were never seeded, so it did not run.",
        status: "unverified" as const,
        owner: "client" as const,
        passedCount: 0,
        gapCount: 1,
        bugCount: 0,
        checkedThisRunCount: 1,
        testSlugs: ["checkout-coupon"],
      },
      {
        title: "Invoices",
        detail: "Most of the invoice list held up; one export check timed out on our runner.",
        status: "partial" as const,
        owner: "autonoma" as const,
        passedCount: 3,
        gapCount: 1,
        bugCount: 0,
        checkedThisRunCount: 0,
        testSlugs: ["inv-list", "inv-detail", "inv-filter", "inv-export"],
      },
    ],

    reportEvidence: [{ assetId: "asset_report_1", url: MOCK_SCREENSHOT, kind: "screenshot" }],
    run: {
      state: "bug_found",
      coverage: {
        byCategory: [
          { category: "engine_artifact", count: 1 },
          { category: "scenario_issue", count: 1 },
        ],
        total: 2,
      },
      bugCount: 1,
      passedCount: 2,
      testCount: 5,
    },
    verdict: { state: "bug_found", bugCount: 1, coverageGapCount: 2, investigatedCount: 5 },
    branchId: BRANCH_ID,
    findings: [
      withRunSignals({
        id: "checkout-place-order",
        slug: "checkout-place-order",
        category: "client_bug",
        headline: "Place order button never enables on the checkout page",
        confidence: "high",
        issueId: "issue_place_order",
        issueTitle: "Place order button never enables on checkout",
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
      }),
      withRunSignals({
        id: "guest-add-to-cart",
        slug: "guest-add-to-cart",
        category: "passed",
        headline: "A guest can add items to the cart",
        confidence: "high",
        evidence: [],
        stepCount: 8,
        runSuccess: true,
      }),
      withRunSignals({
        id: "cart-badge-count",
        slug: "cart-badge-count",
        category: "passed",
        headline: "The cart badge reflects the number of items",
        evidence: [],
        stepCount: 6,
        runSuccess: true,
      }),
      withRunSignals({
        id: "coupon-apply",
        slug: "coupon-apply",
        category: "scenario_issue",
        headline: "Coupon test data was not seeded for this run",
        evidence: [],
      }),
      withRunSignals({
        id: "payment-iframe",
        slug: "payment-iframe",
        category: "engine_artifact",
        headline: "The payment iframe did not load in the harness",
        evidence: [],
      }),
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
    // These stories fixture the authoritative pipeline, which is what the overview gates on.
    analyzed: true,
    settled: true,
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
    summary: {
      tone: overrides.tone,
      label: overrides.label,
      executionState: (overrides.tone === "critical" ? "failed" : "passed") as "failed" | "passed",
      testCounts: {
        assigned: totalTests,
        run: totalTests,
        passed: overrides.passing,
        failed: overrides.failing,
        setupFailed: 0,
        running: 0,
        notRun: 0,
      },
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
    passing: 3,
    failing: 0,
  }),
];

// The newest run, settled as failed: the snapshot carries the `failed` status settlement writes, and its summary
// reports the pipeline failure rather than a test breakdown (there are no findings to break down).
const failedSnapshotHistoryItem: (typeof snapshotHistory)[number] = {
  ...snapshotHistory[0]!,
  status: "failed",
  summary: {
    ...snapshotHistory[0]!.summary!,
    tone: "critical",
    label: "Checkpoint failed",
    reason: "pipeline error",
    executionState: "pipeline_failed",
    analysis: { jobStatus: "failed", bugCount: 0, passedCount: 0, coverageCount: 0 },
  },
};

// Chrome the app shell + PR header/tab bar need on every PR page, independent of the checkpoint content.
const chromeFixtures: TrpcFixtures = {
  branches: {
    list: branchPage(),
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
      sdkAppUrl: null,
      sdkPath: null,
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
      previewVerificationError: null,
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
          analysisIssues,
          analysisJob: { status: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT },
        }),
      ),
    },
  },
};

// The same report, but with flows whose `testSlugs` cite the run's actual findings - so each flow can expand to the
// checks behind it. The shared `analysisReport` above deliberately cites carried-over slugs with no finding this run
// (the common real case, where a flow's dropdown stays empty), so this variant exists to exercise the populated one.
const flowsAlignedReport: NonNullable<TrpcFixtures["branches"]> = {
  analysisReport: {
    ...analysisReport.analysisReport!,
    flows: [
      {
        title: "Guest checkout",
        detail: "The Place order button never enabled, so a guest could not submit - though add-to-cart held up.",
        status: "broken" as const,
        owner: "client" as const,
        passedCount: 1,
        gapCount: 0,
        bugCount: 1,
        checkedThisRunCount: 2,
        testSlugs: ["checkout-place-order", "guest-add-to-cart"],
      },
      {
        title: "Cart badge counter",
        detail: "The badge reflected the cart's item count end to end.",
        status: "verified" as const,
        owner: "none" as const,
        passedCount: 1,
        gapCount: 0,
        bugCount: 0,
        checkedThisRunCount: 1,
        testSlugs: ["cart-badge-count"],
      },
      {
        title: "Coupons and payment",
        detail: "Neither check could run: the coupon fixtures were unseeded and the payment iframe never loaded.",
        status: "unverified" as const,
        owner: "autonoma" as const,
        passedCount: 0,
        gapCount: 2,
        bugCount: 0,
        checkedThisRunCount: 2,
        testSlugs: ["coupon-apply", "payment-iframe"],
      },
    ],
  },
};

const flowsHandlers = appShellHandlers(
  pageFixtures({
    ...flowsAlignedReport,
    analysisIssues,
    analysisJob: { status: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT },
  }),
);

/** The flow itemization at rest: each flow shows its `N findings` disclosure collapsed. */
export const FlowsCollapsed: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: { msw: { handlers: flowsHandlers } },
};

/** The same itemization with every flow's disclosure open: the finding rows, each linking to its finding page. */
export const FlowsExpanded: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: { msw: { handlers: flowsHandlers } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("What this PR covers");
    // The flow list is the only <details> on this page, so open them all rather than matching disclosure copy.
    for (const details of canvasElement.querySelectorAll("details")) details.setAttribute("open", "");
  },
};

/**
 * A run still in flight with no earlier settled report: the PR page shows no live progress, only a card linking
 * into the in-progress checkpoint where the staged view lives.
 */
export const Running: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        pageFixtures({
          analysisReport: null,
          analysisIssues,
          analysisJob: { status: "running", startedAt: STARTED_AT },
        }),
      ),
    },
  },
};

// A run with NO client bug but open coverage gaps: the app held up on what the run reached, but the change was not
// fully confirmed. The verdict headline must state the ratio, never green - "no bug" is not "verified".
const NOT_CONFIRMED_SUMMARY =
  "No client bugs, but Autonoma couldn't fully confirm this change: the coupon scenario wasn't seeded and the " +
  "payment iframe never loaded in the harness, so the reworked checkout submit path went partly unverified.";

const NOT_CONFIRMED_REPORT_MARKDOWN = [
  "## Checkout rework",
  "",
  "The app held up on the flows the run reached - cart, add-to-cart and the badge counter all behaved. But the run " +
    "could not confirm the change end to end: the [coupon scenario was not seeded](issue:issue_coupon), and the " +
    "[payment iframe never loaded in the harness](issue:issue_payment). Neither is a client bug and neither blocks " +
    "the PR, but the checkout submit path this diff reworks was not fully exercised.",
].join("\n");

const notConfirmedIssues: NonNullable<TrpcFixtures["branches"]>["analysisIssues"] = [
  {
    id: "issue_coupon",
    title: "Coupon scenario is not seeded",
    kind: "scenario",
    severity: "medium",
    status: "open",
    runCount: 1,
  },
  {
    id: "issue_payment",
    title: "Payment iframe never loaded in the harness",
    kind: "scenario",
    severity: "low",
    status: "open",
    runCount: 1,
  },
];

const notConfirmedReport: NonNullable<TrpcFixtures["branches"]> = {
  analysisReport: {
    impactReasoning:
      "This PR reworks the checkout submit handler. I re-ran the two checkout tests that exercise it plus the cart " +
      "and add-to-cart flows.",
    reportMarkdown: NOT_CONFIRMED_REPORT_MARKDOWN,
    title: "Orders verified; coupons couldn't be seeded",
    headline: NOT_CONFIRMED_SUMMARY,
    flows: [
      {
        title: "Guest checkout",
        detail: "Cart totals and the confirmation screen were confirmed end to end.",
        status: "verified" as const,
        owner: "none" as const,
        passedCount: 2,
        gapCount: 0,
        bugCount: 0,
        checkedThisRunCount: 2,
        testSlugs: ["checkout-guest", "checkout-confirm"],
      },
      {
        title: "Coupon codes",
        detail: "The coupon fixtures this flow needs were never seeded, so it did not run.",
        status: "unverified" as const,
        owner: "client" as const,
        passedCount: 0,
        gapCount: 1,
        bugCount: 0,
        checkedThisRunCount: 1,
        testSlugs: ["checkout-coupon"],
      },
      {
        title: "Invoices",
        detail: "Most of the invoice list held up; one export check timed out on our runner.",
        status: "partial" as const,
        owner: "autonoma" as const,
        passedCount: 3,
        gapCount: 1,
        bugCount: 0,
        checkedThisRunCount: 0,
        testSlugs: ["inv-list", "inv-detail", "inv-filter", "inv-export"],
      },
    ],

    reportEvidence: [],
    run: {
      state: "healthy",
      coverage: { byCategory: [], total: 0 },
      bugCount: 0,
      passedCount: 5,
      testCount: 5,
    },
    verdict: { state: "healthy", bugCount: 0, coverageGapCount: 0, investigatedCount: 5 },
    branchId: BRANCH_ID,
    // The PR overview renders the prose + open-issues list, not the per-snapshot findings, so this stays empty.
    findings: [],
  },
};

// The latest checkpoint: no bug, but coverage gaps left the change unconfirmed. Stated as the ratio the buckets
// carry rather than as an alarm - only a bug is raised as a problem - while health stays `unknown`, never green, so
// the rail and the header agree with the verdict headline.
const notConfirmedLatest: (typeof snapshotHistory)[number] = {
  ...snapshotHistory[0]!,
  health: "unknown",
  summary: {
    ...snapshotHistory[0]!.summary!,
    tone: "neutral",
    label: "3/5 verified",
    reason: "2 couldn't complete",
    executionState: "not_started",
    analysis: { jobStatus: "completed", bugCount: 0, passedCount: 3, coverageCount: 2 },
  },
};

/** No client bug, but coverage gaps: the verdict headline states how much was verified, and is not green. */
export const NotConfirmed: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...chromeFixtures,
        branches: {
          ...chromeFixtures.branches,
          snapshotHistory: [notConfirmedLatest, snapshotHistory[1]!],
          ...notConfirmedReport,
          analysisIssues: notConfirmedIssues,
          analysisJob: { status: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT },
        },
      }),
    },
  },
};

// A run that reviewed the diff and decided it needed no test. The two selection counts are both zero, which is what
// makes this a judgement rather than an empty run - and the summary has to say WHY, including that a user-facing
// change was deliberately left unexercised, so the reader can disagree and ask for a test.
const NO_TESTS_NEEDED_SUMMARY =
  "The functional change here is the checkout command palette's keyboard parser, and its new behaviour is already " +
  "covered by unit tests, so no browser test was affected and none was authored. The palette is user-facing and " +
  "this run did not exercise it - ask for a test if you want that path covered. The coupon scenario gap from an " +
  "earlier run on this branch is still open.";

const NO_TESTS_NEEDED_REPORT_MARKDOWN = [
  "## Checkout command palette",
  "",
  "This PR changes how the checkout command palette parses keyboard input. The new parsing behaviour is already " +
    "covered by unit tests in the same commit, so no managed browser test was affected and none was worth " +
    "authoring for it.",
  "",
  "The palette is a user-facing surface and this run did not exercise it. That was a deliberate call, not an " +
    "oversight - if you would rather have browser coverage for it, say so and it will be authored on the next run.",
  "",
  "Unrelated to this diff, the [coupon scenario is still not seeded](issue:issue_coupon) from an earlier run on " +
    "this branch. Nothing this run did clears it.",
].join("\n");

// The branch still carries an environment/scenario gap an earlier run opened. A run that needed no test cleared
// none of them, so the open-issues list and the headline pill must still show it under this verdict.
const carriedCoverageIssues: NonNullable<TrpcFixtures["branches"]>["analysisIssues"] = [
  {
    id: "issue_coupon",
    title: "Coupon scenario is not seeded",
    kind: "scenario",
    severity: "medium",
    status: "open",
    runCount: 2,
  },
];

const noTestsNeededReport: NonNullable<TrpcFixtures["branches"]> = {
  analysisReport: {
    impactReasoning:
      "I reviewed the available managed test flows against this diff. The change is confined to the command-palette " +
      "key parser; no existing flow exercises it and the accompanying unit tests already cover the new behaviour.",
    reportMarkdown: NO_TESTS_NEEDED_REPORT_MARKDOWN,
    title: "No tests needed for this change",
    headline: NO_TESTS_NEEDED_SUMMARY,
    flows: [],

    reportEvidence: [],
    run: {
      state: "no_tests_needed",
      coverage: { byCategory: [], total: 0 },
      bugCount: 0,
      passedCount: 0,
      testCount: 0,
    },
    verdict: { state: "no_tests_needed", bugCount: 0, coverageGapCount: 0, investigatedCount: 0 },
    branchId: BRANCH_ID,
    findings: [],
  },
};

// The latest checkpoint, green: the run reached its conclusion, so it is `passed` and never one of the "we have not
// run yet" states - the rail and header agree with the verdict headline.
const noTestsNeededLatest: (typeof snapshotHistory)[number] = {
  ...snapshotHistory[0]!,
  health: "healthy",
  summary: {
    ...snapshotHistory[0]!.summary!,
    tone: "success",
    label: "No tests needed",
    reason: undefined,
    executionState: "passed",
    analysis: { jobStatus: "completed", bugCount: 0, passedCount: 0, coverageCount: 0 },
  },
};

/** The agent decided the change needed no test: green, with the reason in the prose and the carried gap still listed. */
export const NoTestsNeeded: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...chromeFixtures,
        branches: {
          ...chromeFixtures.branches,
          snapshotHistory: [noTestsNeededLatest, snapshotHistory[1]!],
          ...noTestsNeededReport,
          analysisIssues: carriedCoverageIssues,
          analysisJob: { status: "completed", startedAt: STARTED_AT, completedAt: COMPLETED_AT },
        },
      }),
    },
  },
};

/**
 * A run that died before producing a report. The header pill, the history rail and the body must all say the run
 * failed - before `analysis_failed` existed the header fell through to the previous commit's green summary.
 */
export const AnalysisFailed: Story = {
  args: { path: OVERVIEW_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        pageFixtures({
          analysisReport: null,
          // The run died before the Reporter, so it opened no issues - but the PR loader prefetches them anyway.
          analysisIssues: [],
          analysisJob: {
            status: "failed",
            startedAt: STARTED_AT,
            completedAt: COMPLETED_AT,
            failureReason:
              "The Reporter timed out after 20m (3 suite changes discarded; they will be recomputed on the next push)",
          },
          snapshotHistory: [failedSnapshotHistoryItem, ...snapshotHistory.slice(1)],
          pipelineStatusByBranchId: { kind: "analysis_failed" },
        }),
      ),
    },
  },
};
