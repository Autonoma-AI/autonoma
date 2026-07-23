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
