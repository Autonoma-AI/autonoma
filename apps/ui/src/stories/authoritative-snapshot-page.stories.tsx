import type { AnalysisFindingView } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";
import { userEvent, within } from "storybook/test";
import { withRunSignals } from "./analysis-run-signals";

/** The analysis report as the snapshot page's tRPC output types it - what the fixtures below are checked against. */
type AnalysisReportFixture = NonNullable<NonNullable<TrpcFixtures["branches"]>["analysisReport"]>;

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");
const RUN_AT = new Date("2026-01-01T11:24:00.000Z");
const PR_NUMBER = 482;
const SNAPSHOT_ID = "snap_pr482_auth_01";
const BRANCH_ID = "branch_pr482";
const HEAD_SHA = "b41d9c07e2f5a8c1d3e6f90a2b4c6d8e0f123456";
const BASE_SHA = "a13c8b06d1e4a7b0c2d5e8f9012a3b4c5d6e7f80";

// Illustrative run media for the evidence page - a stand-in, not a real agent capture. The screenshot is an
// inline SVG (a mock checkout with a disabled "Place order" button) so it renders deterministically with no
// network; the recording points at a public sample clip to exercise the video slot + speed controls.
const MOCK_SCREENSHOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='820' viewBox='0 0 1200 820'>
    <rect width='1200' height='820' fill='#f5f6f8'/>
    <rect width='1200' height='48' fill='#e6e8ec'/>
    <circle cx='28' cy='24' r='6' fill='#ff5f57'/><circle cx='50' cy='24' r='6' fill='#febc2e'/><circle cx='72' cy='24' r='6' fill='#28c840'/>
    <rect x='110' y='14' width='980' height='20' rx='10' fill='#ffffff'/>
    <text x='128' y='29' font-family='sans-serif' font-size='12' fill='#8a94a6'>app.acme.example.com/checkout</text>
    <rect x='360' y='150' width='480' height='520' rx='12' fill='#ffffff' stroke='#e2e5ea'/>
    <text x='400' y='214' font-family='sans-serif' font-size='24' font-weight='600' fill='#1f2430'>Checkout</text>
    <text x='400' y='262' font-family='sans-serif' font-size='13' fill='#6b7280'>Card number</text>
    <rect x='400' y='274' width='400' height='40' rx='8' fill='#f0f2f5' stroke='#d7dbe2'/>
    <text x='416' y='299' font-family='monospace' font-size='14' fill='#1f2430'>4242 4242 4242 4242</text>
    <text x='400' y='344' font-family='sans-serif' font-size='13' fill='#6b7280'>Shipping address</text>
    <rect x='400' y='356' width='400' height='40' rx='8' fill='#f0f2f5' stroke='#d7dbe2'/>
    <text x='416' y='381' font-family='sans-serif' font-size='14' fill='#1f2430'>1 Market St, San Francisco, CA</text>
    <rect x='400' y='474' width='400' height='48' rx='8' fill='#c7ccd6'/>
    <text x='600' y='504' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='600' fill='#8a90a0'>Place order</text>
    <text x='400' y='552' font-family='sans-serif' font-size='12' fill='#e0564b'>Button stays disabled even though every field is valid</text>
  </svg>`,
)}`;
const PLACE_ORDER_SNIPPET = `function PlaceOrder({ form }: { form: CheckoutForm }) {
  // formValid is computed ONCE, at mount...
  const [formValid] = useState(() => isFormValid(form));

  // ...but the async address validation that resolves later never
  // recomputes it, so the button stays disabled on the happy path.
  return (
    <button disabled={!formValid} onClick={submitOrder}>
      Place order
    </button>
  );
}`;

// The Reporter's report-as-of-this-job prose. Exercises the inline tokens: a link to the issue this finding rolls
// up to, a link to the finding itself, an evidence image backed by `reportEvidence`, and - because the prose is
// PR-cumulative even here - a link to an issue with NO finding in this run, which resolves via the branch's issue
// set rather than this job's findings.
const REPORT_MARKDOWN = [
  "## This checkpoint",
  "",
  "One client bug this run: the [Place order button never enables](issue:issue_place_order), traced through " +
    "[checkout-place-order](finding:checkout-place-order).",
  "",
  "![The disabled Place order button](evidence:asset_report_1)",
  "",
  "The cart and add-to-cart flows passed. Two checks could not confirm app health and don't block the PR. The " +
    "[cart badge miscount](issue:issue_cart_badge) carried over from an earlier checkpoint is still open.",
].join("\n");

// The branch's issues. This run's findings only touch the place-order bug, so the cart-badge issue is exactly the
// carried-forward case: its `issue:` token must still link, which only works because the resolver reads the BRANCH.
const analysisIssues: NonNullable<TrpcFixtures["branches"]>["analysisIssues"] = [
  {
    id: "issue_place_order",
    title: "Place order button never enables on checkout",
    kind: "bug",
    severity: "critical",
    status: "open",
    runCount: 1,
    thumbnailUrl: MOCK_SCREENSHOT,
  },
  {
    id: "issue_cart_badge",
    title: "Cart badge miscounts items after removal",
    kind: "bug",
    severity: "high",
    status: "open",
    runCount: 3,
  },
];

// The authoritative analysis report: one client bug (the actionable finding), a pair of passed tests, and two
// non-blocking coverage findings (scenario + engine), plus the report prose and impact-analysis reasoning. Named on
// its own so the needs-review variant below can extend it without restating the prose.
const analysisReportData: AnalysisReportFixture = {
  impactReasoning:
    "This PR reworks the checkout submit handler and the cart badge counter. I re-ran the two existing " +
    "checkout tests that exercise those surfaces and authored one new test for the guest add-to-cart path the " +
    "diff opens up.",
  reportMarkdown: REPORT_MARKDOWN,
  flows: [],
  title: "Checkout blocked at Place order",
  headline:
    "Checkout is broken on this PR: the Place order button never enables even with a valid card and address, so " +
    "no customer can complete a purchase.",
  reportEvidence: [{ assetId: "asset_report_1", url: MOCK_SCREENSHOT, kind: "screenshot" }],
  verdict: "client_bug",
  clientBugCount: 1,
  testCount: 5,
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
        "The submit handler reads a `formValid` flag that is computed once on mount and never recomputed after " +
        "the async address-validation promise resolves, so the button stays disabled on the happy path.",
      remediation:
        "Recompute form validity after the address-validation promise settles, or gate the button on the " +
        "validated address flag instead of the stale mount-time value.",
      evidence: [
        { source: "run", detail: "The Place order button kept aria-disabled after all fields were valid." },
        {
          source: "code",
          detail: "The submit handler never re-reads validity once address validation resolves.",
          file: "src/checkout/PlaceOrder.tsx",
          lines: "42-58",
          snippet: PLACE_ORDER_SNIPPET,
        },
      ],
      keyScreenshotUrl: MOCK_SCREENSHOT,
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
};

const analysisReport: NonNullable<TrpcFixtures["branches"]> = { analysisReport: analysisReportData };

/**
 * The same run plus one test the Investigator could not stabilize: it classified the plan as wrong on a healthy app,
 * rewrote it, re-ran it, and the rewrite failed too - so the loop exhausted, reverted the rewrite and KEPT the test as
 * a `plan_mismatch`. Its two classifications are that history. Non-blocking, so the run stays at one client bug.
 */
const KEPT_PLAN_MISMATCH: AnalysisFindingView = {
  id: "cart-drawer-subtotal",
  slug: "cart-drawer-subtotal",
  category: "plan_mismatch",
  confidence: "high",
  planFidelity: "exact",
  headline: "Cart drawer test asserts a subtotal row the PR moved behind a disclosure",
  planMismatchNote:
    'The test asserts the subtotal reads "$48.00" in the drawer, but this PR moved the totals behind a "Show ' +
    'summary" disclosure, so nothing renders until it is expanded. I rewrote the plan to expand it first and re-ran: ' +
    "the disclosure only appears once the drawer finishes its open animation, which the plan has no way to await. " +
    "Keeping the original plan for a later run rather than promoting a rewrite that still fails.",
  evidence: [
    {
      source: "code",
      detail: "The totals block moved inside a collapsed disclosure in this PR.",
      file: "components/cart/cart-drawer.tsx",
      lines: "64-71",
      snippet:
        '-  <SubtotalRow value={subtotal} />\n+  <Disclosure label="Show summary">\n+    <SubtotalRow value={subtotal} />',
    },
  ],
  stepCount: 9,
  runSuccess: false,
  generationId: "gen_cart_drawer_subtotal_2",
  testCase: { id: "tc_cart_drawer_subtotal", name: "cart-drawer-subtotal.md", slug: "cart-drawer-subtotal" },
  origin: "pre_existing",
  selectionReason: "The diff restructures the cart drawer totals this test asserts on.",
  classifications: [
    {
      id: "cls_cart_drawer_1",
      number: 1,
      generationId: "gen_cart_drawer_subtotal_1",
      category: "plan_mismatch",
      headline: "The subtotal row is no longer rendered inline",
      createdAt: FIXTURE_EPOCH,
    },
    {
      id: "cls_cart_drawer_2",
      number: 2,
      generationId: "gen_cart_drawer_subtotal_2",
      category: "plan_mismatch",
      headline: "Cart drawer test asserts a subtotal row the PR moved behind a disclosure",
      createdAt: RUN_AT,
    },
  ],
};

/**
 * A test the Investigator found irreparably broken: it asserts a Reports export the app has never had, so no rewrite
 * could recover it and the run REMOVED it (an `invalid_test`). Its assignment is gone from the promoted suite, which is
 * why the suite-changes view files it under "Removed"; the finding + its classification survive as the record of why.
 * Non-blocking coverage, so the run's bug count stays at one.
 */
const INVALID_TEST_FINDING: AnalysisFindingView = {
  id: "export-report-pdf",
  slug: "export-report-pdf",
  category: "invalid_test",
  confidence: "high",
  planFidelity: "diverged",
  headline: "Test drives a Reports export the app has never had",
  invalidTestNote:
    'The test opens a "Reports" tab and asserts a "Download PDF" button, but the app has no Reports surface: there ' +
    "is no route, component, or i18n key for one, and git history shows it never existed. There is no assertion to " +
    "rewrite against an implemented behavior, so the test cannot be recovered and is removed.",
  falsePositiveRisk:
    "Checked git history and the locale catalog - no Reports route, component, or string ever existed, so this is " +
    "not a salvageable stale test.",
  evidence: [
    {
      source: "code",
      detail: "No `/reports` route is registered anywhere in the router tree.",
      file: "apps/web/src/router.tsx",
      lines: "1-120",
      snippet: '// no "/reports" route is registered anywhere in the router tree',
    },
  ],
  stepCount: 4,
  runSuccess: false,
  generationId: "gen_export_report_pdf_1",
  testCase: { id: "tc_export_report_pdf", name: "export-report-pdf.md", slug: "export-report-pdf" },
  origin: "pre_existing",
  selectionReason: "The diff touches the reporting module this test was generated against.",
  classifications: [
    {
      id: "cls_export_report_pdf_1",
      number: 1,
      generationId: "gen_export_report_pdf_1",
      category: "invalid_test",
      headline: "Test drives a Reports export the app has never had",
      createdAt: RUN_AT,
    },
  ],
};

// The one bug issue this run opened, as a list summary - shown in the snapshot's per-job "Issues this checkpoint".
const PLACE_ORDER_ISSUE_SUMMARY = {
  id: "issue_place_order",
  title: "Place order button never enables on checkout",
  kind: "bug" as const,
  severity: "critical" as const,
  status: "open" as const,
  runCount: 1,
  thumbnailUrl: MOCK_SCREENSHOT,
};

// The per-job issue-set changes: this run opened the place-order bug; nothing carried forward or resolved.
const analysisSnapshotIssueChanges: NonNullable<TrpcFixtures["branches"]> = {
  analysisSnapshotIssueChanges: { opened: [PLACE_ORDER_ISSUE_SUMMARY], carriedForward: [], resolved: [] },
};

// The full issue detail, reached from the PR list or a finding's up-link. Exercises the narrative's inline
// `finding:` link + `evidence:` image, the suspected cause, and the cross-snapshot finding instances.
const analysisIssueDetail: NonNullable<TrpcFixtures["branches"]> = {
  analysisIssueDetail: {
    id: "issue_place_order",
    title: "Place order button never enables on checkout",
    kind: "bug",
    severity: "critical",
    status: "open",
    expectedBehavior:
      "With a valid saved card and a complete shipping address, the Place order button should enable so the " +
      "customer can submit the order.",
    actualBehavior:
      "Every field validated but the Place order button stayed disabled, so the order could never submit.",
    narrativeMarkdown: [
      "The checkout form validates correctly, but the submit button never enables - see " +
        "[checkout-place-order](finding:checkout-place-order).",
      "",
      "![The disabled Place order button](evidence:asset_issue_1)",
    ].join("\n"),
    evidence: [{ assetId: "asset_issue_1", url: MOCK_SCREENSHOT, kind: "screenshot" }],
    suspectedCause: {
      explanation:
        "The submit handler reads a `formValid` flag computed once on mount and never recomputed after the " +
        "async address-validation promise resolves.",
      codeReferences: [{ file: "src/checkout/PlaceOrder.tsx", lines: "42-58", snippet: PLACE_ORDER_SNIPPET }],
    },
    primaryScreenshot: { url: MOCK_SCREENSHOT, points: [] },
    findingInstances: [
      {
        snapshotId: SNAPSHOT_ID,
        snapshotCreatedAt: RUN_AT,
        headSha: HEAD_SHA,
        findingId: "checkout-place-order",
        slug: "checkout-place-order",
        category: "client_bug",
        headline: "Place order button never enables on the checkout page",
      },
    ],
  },
};

const snapshotReport: NonNullable<TrpcFixtures["branches"]> = {
  snapshotReport: {
    snapshot: {
      id: SNAPSHOT_ID,
      status: "active",
      source: "GITHUB_PUSH",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      createdAt: RUN_AT,
      branch: { id: BRANCH_ID, name: "feat/checkout-rework", prNumber: PR_NUMBER },
    },
    trigger: {
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      source: "GITHUB_PUSH",
      createdAt: RUN_AT,
      filesChanged: [],
      filesChangedTruncated: false,
    },
    // The header reads `summary.analysis` for an authoritative run, so this tally is deliberately left at zero:
    // the fixture asserts the analysis vocabulary wins, not that the two agree.
    results: {
      durationMs: 214_000,
      passed: 0,
      failed: 0,
      setupFailed: 0,
      pending: 5,
      running: 0,
      total: 5,
      tests: [],
    },
    health: "critical",
    healthCounts: { failing: 3, passing: 2, running: 0, setupFailed: 0, notAffected: 0, totalTests: 5 },
    // What `buildAuthoritativeCheckpointSummary` produces for this run: the `analysis` block is the authoritative
    // tally, and the legacy `testCounts` deliberately leave failed/running at zero.
    summary: {
      tone: "critical",
      label: "Needs attention",
      reason: "1 couldn't confirm",
      executionState: "failed",
      testCounts: { assigned: 24, run: 5, passed: 2, failed: 0, setupFailed: 0, running: 0, notRun: 19 },
      suiteChangeCount: 2,
      analysis: { jobStatus: "completed", bugCount: 1, passedCount: 2, coverageCount: 2 },
    },
  },
};

const snapshotDetail: NonNullable<TrpcFixtures["branches"]> = {
  snapshotDetail: {
    snapshot: {
      id: SNAPSHOT_ID,
      status: "active",
      source: "GITHUB_PUSH",
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      createdAt: RUN_AT,
      prevSnapshotId: null,
      branch: { id: BRANCH_ID, name: "feat/checkout-rework", applicationId: baseApplication.id, prNumber: PR_NUMBER },
    },
    // Only two of the five investigated tests produced a plan diff: the authored one and the self-healed one. The
    // other three ran untouched, which is exactly the case a changes-driven view drops and the findings restore.
    changes: [
      {
        type: "added",
        testCaseId: "tc_guest-add-to-cart",
        testCaseName: "guest-add-to-cart.md",
        testCaseSlug: "guest-add-to-cart",
        testCaseFolderId: "folder_checkout",
        plan: "1. Open the storefront as a guest.\n2. Add the featured item to the cart.\n3. Assert the cart badge reads 1.",
      },
      {
        type: "updated",
        testCaseId: "tc_cart-badge-count",
        testCaseName: "cart-badge-count.md",
        testCaseSlug: "cart-badge-count",
        testCaseFolderId: "folder_checkout",
        plan: '1. Add two items.\n2. Assert the cart badge reads "2 items".',
        previousPlan: "1. Add two items.\n2. Assert the cart badge reads 2.",
      },
    ],
    createdTests: [],
    health: "critical",
    healthCounts: { failing: 3, passing: 2, running: 0, setupFailed: 0, notAffected: 0, totalTests: 5 },
    summary: {
      tone: "critical",
      label: "Needs attention",
      executionState: "failed",
      testCounts: { assigned: 5, run: 5, passed: 2, failed: 3, setupFailed: 0, running: 0, notRun: 0 },
      suiteChangeCount: 0,
    },
    executedTests: [],
  },
};

// The app shell's `app.$appSlug` layout loader resolves the main branch; keep it minimal (no checkpoints).
const mainBranchDetail: NonNullable<TrpcFixtures["branches"]> = {
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
};

// The app shell's sidebar reads these on every page; a completed onboarding state hides the finish-setup nudge.
const shellFixtures: TrpcFixtures = {
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

// The completed run behind the report-first stories. The snapshot page gates on the AnalysisJob's presence, so
// every authoritative story needs one; a completed job is the happy path the report + findings stories render.
const completedJob = { status: "completed" as const, startedAt: FIXTURE_EPOCH, completedAt: RUN_AT };

const pageFixtures: TrpcFixtures = {
  ...shellFixtures,
  branches: {
    ...mainBranchDetail,
    ...snapshotReport,
    ...snapshotDetail,
    ...analysisReport,
    ...analysisSnapshotIssueChanges,
    ...analysisIssueDetail,
    analysisIssues,
    analysisJob: completedJob,
  },
};

// The two run-in-progress states share the report-first chrome but replace the report with a status: the page
// gates on the job, so a running/failed job with a null report renders the AnalysisJob-status fallback. The
// header's `snapshotReport.summary` is server-derived from the job, so it must track the job here too - otherwise
// the badge would show a stale completed tally over a failed/running body.
function jobStateFixtures(
  analysisJob: NonNullable<NonNullable<TrpcFixtures["branches"]>["analysisJob"]>,
): TrpcFixtures {
  const failed = analysisJob.status === "failed";
  const baseReport = snapshotReport.snapshotReport!;
  return {
    ...pageFixtures,
    branches: {
      ...pageFixtures.branches,
      analysisReport: null,
      analysisJob,
      snapshotReport: {
        ...baseReport,
        health: failed ? "critical" : "running",
        summary: {
          ...baseReport.summary!,
          tone: failed ? "critical" : "neutral",
          label: failed ? "Checkpoint failed" : "Analyzing",
          reason: failed ? "pipeline error" : undefined,
          executionState: failed ? "pipeline_failed" : "running",
          analysis: { jobStatus: analysisJob.status, bugCount: 0, passedCount: 0, coverageCount: 0 },
        },
      },
    },
  };
}

const meta = {
  title: "Pages/AuthoritativeSnapshotPage",
  component: PageStory,
  parameters: { pageStory: true, msw: { handlers: appShellHandlers(pageFixtures) } },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

/** The per-job view: the report prose, the run's verdict + findings list, and the issue-set changes this job made. */
export const Report: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}` },
};

/**
 * The suite-changes tab, driven by the run's findings: all five investigated tests are listed, including the three
 * the run left unedited (Checked) that no plan diff would surface. The selected row shows its verdict, why it was
 * selected, and the links to its finding and the generation that produced it.
 */
export const Changes: Story = {
  args: {
    path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}/changes/cart-badge-count`,
  },
};

/**
 * The same row with the plan toggled to its diff: the rewritten assertion reads as a two-word edit rather than two
 * near-identical blocks of prose the reader has to compare by eye.
 */
export const ChangesPlanDiff: Story = {
  args: {
    path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}/changes/cart-badge-count`,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Diff" }));
  },
};

/** A single finding's evidence detail, reached by clicking a finding row - with the up-link to its issue. */
export const Finding: Story = {
  args: {
    path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}/findings/checkout-place-order`,
  },
};

/** The PR-level issue detail: narrative + evidence + suspected cause + the issue's finding instances. */
export const Issue: Story = {
  args: {
    path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/issues/issue_place_order`,
  },
};

/**
 * The findings list with a kept `plan_mismatch` in it: it gets its own visible "Needs review" group between the
 * actionable client bug and the collapsed remainder, because a test the run could not stabilize may be catching a real
 * defect the classifier misdiagnosed. It is still non-blocking - the run's bug count stays at one.
 */
export const ReportNeedsReview: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}` },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...pageFixtures,
        branches: {
          ...pageFixtures.branches,
          analysisReport: {
            ...analysisReportData,
            // Swapped in for the scenario_issue rather than appended: `plan_mismatch` is also a coverage verdict, so
            // the run's bug/passed/coverage counts - and the header tallies fixtured separately from the findings -
            // all stay correct without a second fixture to keep in sync.
            findings: analysisReportData.findings
              .filter((finding) => finding.slug !== "coupon-apply")
              .concat(KEPT_PLAN_MISMATCH),
          },
        },
      }),
    },
  },
};

/**
 * The suite-changes tab with a REMOVED test in it: the Investigator classified this test `invalid_test` (it drives a
 * feature the app never had), so it dropped the assignment and the test appears under "Removed". The selected row shows
 * the "Invalid test" verdict and why it was pulled. The `invalid_test` finding is swapped in for the engine_artifact so
 * the run's coverage count stays correct.
 */
export const ChangesRemoved: Story = {
  args: {
    path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}/changes/export-report-pdf`,
  },
  parameters: {
    msw: {
      handlers: appShellHandlers({
        ...pageFixtures,
        branches: {
          ...pageFixtures.branches,
          analysisReport: {
            ...analysisReportData,
            findings: analysisReportData.findings
              .filter((finding) => finding.slug !== "payment-iframe")
              .concat(INVALID_TEST_FINDING),
          },
        },
      }),
    },
  },
};

/** A run still in flight: no report yet, so the page shows the AnalysisJob "Analyzing" status instead of findings. */
export const Running: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}` },
  parameters: {
    msw: { handlers: appShellHandlers(jobStateFixtures({ status: "running", startedAt: RUN_AT })) },
  },
};

/** A run that died before producing a report. The page shows the failure and its reason where the report would be. */
export const Failed: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}` },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        jobStateFixtures({
          status: "failed",
          startedAt: FIXTURE_EPOCH,
          completedAt: RUN_AT,
          failureReason:
            "The Reporter timed out after 20m (3 suite changes discarded; they will be recomputed on the next push)",
        }),
      ),
    },
  },
};

/** The suite-changes tab for a failed run: the discarded-changes notice, not the raw plan diff. */
export const ChangesFailed: Story = {
  args: { path: `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/snapshots/${SNAPSHOT_ID}/changes` },
  parameters: {
    msw: {
      handlers: appShellHandlers(jobStateFixtures({ status: "failed", startedAt: FIXTURE_EPOCH, completedAt: RUN_AT })),
    },
  },
};
