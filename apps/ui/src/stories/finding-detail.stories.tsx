import type { InvestigationFinding } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { analysisVerdictMeta } from "components/analysis/verdict-meta";
import { FindingDetail } from "components/investigation/finding-detail";

/**
 * The finding evidence page. When the run has a dead-time-stripped recording, its `VideoPlayer` shows an
 * Optimized/Original toggle bottom-left, on the same line as the speed selector; legacy runs with no optimized
 * recording show just the "Run recording" caption there.
 */
const meta = {
  title: "Pages/FindingDetail",
  component: FindingDetail,
  decorators: [
    (Story) => (
      <div className="mx-auto max-w-4xl p-8">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof FindingDetail>;
export default meta;

type Story = StoryObj<typeof meta>;

const baseFinding: InvestigationFinding = {
  id: "create-card-with-custom-color-md",
  slug: "create-card-with-custom-color-md",
  category: "client_bug",
  confidence: "medium",
  stepCount: 11,
  headline: "Card color lookup skips the matching palette entry",
  whatHappened:
    'The run completed card creation successfully: the count became "4 Active," and "Emerald Card" appeared with a ' +
    '"VIRTUAL" label. The final UI rendered Emerald Card pink/red like Rose instead of green like Emerald; this ' +
    "test has never passed before, so no historical baseline exists.",
  remediation:
    "Make the palette lookup return the selected color's own value rather than the following entry, while " +
    "preserving the existing card creation and rendering flow. Update colorValue in lib/card-colors.ts and " +
    "retain the current Emerald selection behavior.",
  observedAppIssues:
    "Emerald Card is visibly rendered with a pink/red Rose background instead of the selected green Emerald color.",
  evidence: [
    {
      source: "code",
      detail: "The palette lookup indexes the next entry instead of the matched one.",
      file: "lib/card-colors.ts",
      lines: "42-48",
      snippet:
        "const index = PALETTE.findIndex((c) => c.name === selected);\n// off-by-one: returns the following swatch\nreturn PALETTE[index + 1].value;",
    },
  ],
  coveredSlugs: [
    "create-card-with-custom-color-md",
    "create-physical-card-md",
    "create-virtual-card-md",
    "internal-transfer-and-card-creation-md",
    "notifications-and-physical-card-creation-md",
  ],
  videoUrl: "https://assets.autonoma.app/test-generation/demo/video.webm",
};

const backLink = <span className="font-mono text-2xs">←</span>;

/** With an optimized recording: the run recording shows the Optimized/Original toggle bottom-left. */
export const WithOptimizedToggle: Story = {
  args: {
    finding: {
      ...baseFinding,
      optimizedVideoUrl: "https://assets.autonoma.app/test-generation/demo/optimized.mp4",
    },
    meta: analysisVerdictMeta(baseFinding.category),
    backLink,
  },
};

/** Legacy run with no optimized recording: the "Run recording" caption shows instead of the toggle. */
export const OriginalOnly: Story = {
  args: {
    finding: baseFinding,
    meta: analysisVerdictMeta(baseFinding.category),
    backLink,
  },
};

/**
 * A kept `plan_mismatch`: the app worked, the test's plan did not match it, and self-heal could not stabilize it
 * within budget. It carries no app expected/actual - there is no app-behavior claim to make - so its diagnosis is the
 * "Why it could not be stabilized" post-mortem instead.
 */
export const PlanMismatch: Story = {
  args: {
    finding: {
      id: "cart-badge-count-md",
      slug: "cart-badge-count-md",
      category: "plan_mismatch",
      confidence: "high",
      planFidelity: "exact",
      stepCount: 7,
      headline: "Cart badge test asserts a count format the app no longer renders",
      planMismatchNote:
        'The test asserts the badge reads "3 items", but the PR changed the badge to a bare numeral ("3"). I rewrote ' +
        "the assertion to the numeral and re-ran it, and it still failed: the badge only renders once the cart " +
        "drawer has been opened, which this plan never does. Re-recording the flow needs a step the plan does not " +
        "have, so the original plan is kept for a later run rather than replaced with a rewrite that fails.",
      evidence: [
        {
          source: "code",
          detail: "The badge switched to a bare numeral in this PR.",
          file: "components/cart/cart-badge.tsx",
          lines: "18-22",
          snippet: "-  <span>{count} items</span>\n+  <span aria-label={`${count} items`}>{count}</span>",
        },
      ],
      plan: "Setup\n1. Open the storefront.\n\nSteps\n1. click the cart icon\n2. assert the badge reads “3 items”",
      videoUrl: "https://assets.autonoma.app/test-generation/demo/video.webm",
    },
    meta: analysisVerdictMeta("plan_mismatch"),
    backLink,
  },
};

/**
 * An `invalid_test`: the app worked, but the test is irreparably broken - it asserts a feature that never existed, so
 * no rewrite could recover it and the Investigator removed it. Like `plan_mismatch` it carries no app expected/actual;
 * its diagnosis is the "Why this test was removed" justification, which the classifier had to prove.
 */
export const InvalidTest: Story = {
  args: {
    finding: {
      id: "export-report-pdf-md",
      slug: "export-report-pdf-md",
      category: "invalid_test",
      confidence: "high",
      planFidelity: "diverged",
      falsePositiveRisk:
        "Checked the git history and the i18n catalog for a Reports surface - there is no component, route, or " +
        "string for one, so this is not a salvageable stale test.",
      stepCount: 4,
      headline: "Test drives a Reports export that the app has never had",
      invalidTestNote:
        'The test opens a "Reports" tab and asserts a "Download PDF" button, but the app has no Reports surface: ' +
        "there is no route, component, or i18n key for one, and git history shows it never existed. There is no " +
        "assertion to rewrite against an implemented behavior, so the test cannot be recovered and is removed.",
      evidence: [
        {
          source: "code",
          detail: "grep across the app and locale files finds no Reports route, component, or string.",
          file: "apps/web/src/router.tsx",
          lines: "1-120",
          snippet: '// no "/reports" route is registered anywhere in the router tree',
        },
      ],
      plan: 'Setup\n1. Open the app.\n\nSteps\n1. click the "Reports" tab\n2. click "Download PDF"\n3. assert a PDF downloads',
      videoUrl: "https://assets.autonoma.app/test-generation/demo/video.webm",
    },
    meta: analysisVerdictMeta("invalid_test"),
    backLink,
  },
};
