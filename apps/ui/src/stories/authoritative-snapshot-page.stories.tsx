import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

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
// non-blocking coverage findings (scenario + engine), plus the report prose and impact-analysis reasoning.
const analysisReport: NonNullable<TrpcFixtures["branches"]> = {
  analysisReport: {
    impactReasoning:
      "This PR reworks the checkout submit handler and the cart badge counter. I re-ran the two existing " +
      "checkout tests that exercise those surfaces and authored one new test for the guest add-to-cart path the " +
      "diff opens up.",
    reportMarkdown: REPORT_MARKDOWN,
    summary:
      "Checkout is broken on this PR: the Place order button never enables even with a valid card and address, so " +
      "no customer can complete a purchase.",
    reportEvidence: [{ assetId: "asset_report_1", url: MOCK_SCREENSHOT, kind: "screenshot" }],
    verdict: "client_bug",
    clientBugCount: 1,
    testCount: 5,
    branchId: BRANCH_ID,
    findings: [
      {
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
        finalScreenshotUrl: MOCK_SCREENSHOT,
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
    selection: { totalSuiteTests: 24, selected: [] },
    results: {
      durationMs: 214_000,
      passed: 2,
      failed: 3,
      setupFailed: 0,
      pending: 0,
      running: 0,
      total: 5,
      tests: [],
    },
    bugs: [],
    health: "critical",
    healthCounts: { failing: 3, passing: 2, running: 0, setupFailed: 0, notAffected: 0, totalTests: 5 },
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
    changes: [],
    diffsJob: {
      status: "completed",
      analysisReasoning: null,
      failureReason: null,
      startedAt: null,
      completedAt: null,
      affectedTests: [],
      firstIterationReasoning: undefined,
      temporalWorkflow: undefined,
    },
    createdTests: [],
    refinementLoop: undefined,
    health: "critical",
    healthCounts: { failing: 3, passing: 2, running: 0, setupFailed: 0, notAffected: 0, totalTests: 5 },
    summary: {
      tone: "critical",
      label: "Needs attention",
      executionState: "failed",
      openBugCount: 0,
      issueOccurrenceCount: 0,
      testCounts: { assigned: 5, run: 5, passed: 2, failed: 3, setupFailed: 0, running: 0, notRun: 0 },
      failingByKind: { engine: 2, app: 1 },
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
  },
};

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
