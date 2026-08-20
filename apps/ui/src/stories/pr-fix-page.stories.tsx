import type { Meta, StoryObj } from "@storybook/react-vite";
import { appShellHandlers, baseApplication } from "lib/storybook/base-fixtures";
import { PageStory } from "lib/storybook/page-story";
import type { TrpcFixtures } from "lib/storybook/trpc-handler";

const PR_NUMBER = 482;
const APP_URL = "https://autonoma.app";
const PR_URL = `${APP_URL}/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/`;

// An inline-SVG stand-in frame, so the issue cards render their media with no network.
const MOCK_SCREENSHOT = `data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='1200' height='760' viewBox='0 0 1200 760'>
    <rect width='1200' height='760' fill='#f5f6f8'/>
    <rect x='360' y='120' width='480' height='520' rx='12' fill='#ffffff' stroke='#e2e5ea'/>
    <text x='400' y='184' font-family='sans-serif' font-size='24' font-weight='600' fill='#1f2430'>Checkout</text>
    <rect x='400' y='444' width='400' height='48' rx='8' fill='#c7ccd6'/>
    <text x='600' y='474' text-anchor='middle' font-family='sans-serif' font-size='16' font-weight='600' fill='#8a90a0'>Place order</text>
  </svg>`,
)}`;

type AnalysisForPr = NonNullable<TrpcFixtures["branches"]>["analysisForPr"];

const settled: AnalysisForPr = {
  status: "complete",
  verdict: { state: "bug_found", bugCount: 1, coverageGapCount: 2, investigatedCount: 14 },
  title: "Checkout rework",
  headline: "Checkout is broken on this PR: the Place order button never enables, so no customer can buy.",
  flows: [
    {
      title: "Guest checkout",
      detail: "the Place order button never enables with a valid card",
      status: "broken",
      owner: "client",
      passedCount: 1,
      gapCount: 0,
      bugCount: 1,
      checkedThisRunCount: 2,
      testSlugs: ["checkout-place-order", "checkout-guest-cart"],
    },
    {
      title: "Cart",
      detail: "add, remove and quantity edits all held up",
      status: "verified",
      owner: "none",
      passedCount: 3,
      gapCount: 0,
      bugCount: 0,
      checkedThisRunCount: 3,
      testSlugs: ["cart-add", "cart-remove", "cart-quantity"],
    },
    {
      title: "Admin invoicing",
      detail: "could not be checked: the preview has no SMTP key",
      status: "unverified",
      owner: "client",
      passedCount: 0,
      gapCount: 1,
      bugCount: 0,
      checkedThisRunCount: 1,
      testSlugs: ["admin-invoice-email"],
    },
  ],
  reportMarkdown: "This PR introduces one blocking bug and leaves two flows unverified for setup reasons.",
  reportEvidence: [],
  impactReasoning: "The diff touched app/checkout/submit.ts and the cart reducer, so every checkout flow was selected.",
  prUrl: PR_URL,
  issues: [
    {
      id: "issue_place_order",
      title: "Place order button never enables on checkout",
      kind: "bug",
      severity: "critical",
      expectedBehavior: "With a valid card and address, Place order enables and submits the order.",
      actualBehavior: "The button stays disabled, so the order can never be submitted.",
      suspectedCause: {
        explanation:
          "The submit guard reads `form.isValid` before the address validator has resolved, so it latches false.",
        codeReferences: [
          {
            file: "app/checkout/submit.ts",
            lines: "41-58",
            snippet: "const canSubmit = form.isValid && cart.total > 0;",
          },
          { file: "app/checkout/use-address.ts", lines: "12" },
        ],
      },
      screenshotUrl: MOCK_SCREENSHOT,
      runCount: 2,
      issueUrl: `${PR_URL}issues/issue_place_order`,
      replayUrl: `${PR_URL}snapshots/snap_pr482_02/findings/finding_place_order`,
      coveredTests: [
        {
          slug: "checkout-place-order",
          origin: "pre_existing",
          selectionReason: "the PR touched app/checkout/submit.ts",
          category: "client_bug",
        },
      ],
    },
    {
      id: "issue_smtp",
      title: "The preview has no SMTP key, so invoice email cannot be checked",
      kind: "environment",
      severity: "high",
      actualBehavior: "Every send failed with a 401 from the mailer, so the invoice flow never completed.",
      runCount: 3,
      issueUrl: `${PR_URL}issues/issue_smtp`,
      coveredTests: [
        {
          slug: "admin-invoice-email",
          origin: "pre_existing",
          selectionReason: "the PR changed the invoice template",
          category: "environment_failure",
        },
      ],
    },
    {
      id: "issue_coupon",
      title: "The checkout scenario seeds no coupon codes",
      kind: "scenario",
      severity: "medium",
      actualBehavior: "The coupon field is never seeded, so the discount path could not be exercised.",
      runCount: 1,
      issueUrl: `${PR_URL}issues/issue_coupon`,
      coveredTests: [],
    },
  ],
};

const FIXTURE_EPOCH = new Date("2026-01-01T00:00:00.000Z");

// The app shell resolves the main branch on every page; the fix page itself needs nothing from it.
const mainBranch: NonNullable<TrpcFixtures["branches"]>["detailByName"] = {
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
};

function fixtures(analysisForPr: AnalysisForPr): TrpcFixtures {
  return {
    branches: { analysisForPr, detailByName: mainBranch },
    github: {
      getApplicationRepository: {
        id: 1,
        name: "storefront",
        fullName: "acme/storefront",
        private: true,
        defaultBranch: "main",
      },
    },
  };
}

const meta = {
  title: "Pages/PRFixPage",
  component: PageStory,
  parameters: { pageStory: true },
} satisfies Meta<typeof PageStory>;

export default meta;

type Story = StoryObj<typeof meta>;

const FIX_PATH = `/app/${baseApplication.slug}/pull-requests/${PR_NUMBER}/fix`;

export const Issues: Story = {
  args: { path: FIX_PATH },
  parameters: { msw: { handlers: appShellHandlers(fixtures(settled)) } },
};

export const Running: Story = {
  args: { path: FIX_PATH },
  parameters: { msw: { handlers: appShellHandlers(fixtures({ status: "in_progress" })) } },
};

export const RunFailed: Story = {
  args: { path: FIX_PATH },
  parameters: {
    msw: {
      handlers: appShellHandlers(
        fixtures({ status: "failed", failureReason: "The preview was unreachable for the whole run." }),
      ),
    },
  },
};
