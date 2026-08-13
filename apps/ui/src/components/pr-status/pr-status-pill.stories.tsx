import type { CheckpointPresentationSummary, PrPipelineStatus } from "@autonoma/types";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { PrStatusPill } from "./pr-status-pill";

/**
 * The one pill every surface uses to say what happened to a pull request.
 *
 * Its labels come from the server, so the fixtures below are the real strings `derivePresentation` emits - not
 * invented ones. That matters: the two longest ("Checkpoint failed", "No tests affected") are exactly what the
 * Health column is sized around, and the stories that used shorter invented labels are why the column's
 * overflow went unnoticed for so long.
 */

function summary(overrides: Partial<CheckpointPresentationSummary>): CheckpointPresentationSummary {
  return {
    tone: "neutral",
    label: "Unknown",
    executionState: "unknown",
    testCounts: { assigned: 0, run: 0, passed: 0, failed: 0, setupFailed: 0, running: 0, notRun: 0 },
    suiteChangeCount: 0,
    ...overrides,
  };
}

const EVERY_STATUS: { caption: string; status: PrPipelineStatus }[] = [
  {
    caption: "checkpoint · passing",
    status: { kind: "checkpoint", summary: summary({ tone: "success", label: "Passing", executionState: "passed" }) },
  },
  {
    caption: "checkpoint · bugs",
    status: {
      kind: "checkpoint",
      summary: summary({ tone: "critical", label: "2 bugs", reason: "5 occurrences", executionState: "failed" }),
    },
  },
  {
    caption: "checkpoint · pipeline died",
    status: {
      kind: "checkpoint",
      summary: summary({
        tone: "critical",
        label: "Checkpoint failed",
        reason: "pipeline error",
        executionState: "pipeline_failed",
      }),
    },
  },
  {
    caption: "checkpoint · coverage gap",
    status: {
      kind: "checkpoint",
      summary: summary({ tone: "warning", label: "Not confirmed", reason: "12 couldn't confirm" }),
    },
  },
  {
    caption: "checkpoint · nothing selected",
    status: { kind: "checkpoint", summary: summary({ label: "No tests affected" }) },
  },
  {
    caption: "checkpoint · stale",
    status: {
      kind: "checkpoint",
      summary: summary({ tone: "warning", label: "Stale results", reason: "rerun pending", executionState: "stale" }),
    },
  },
  { caption: "building", status: { kind: "building" } },
  { caption: "pending_checks", status: { kind: "pending_checks" } },
  { caption: "analyzing", status: { kind: "analyzing" } },
  { caption: "analysis_failed", status: { kind: "analysis_failed" } },
  { caption: "build_failed", status: { kind: "build_failed" } },
  { caption: "none", status: { kind: "none" } },
];

/** The Health column's real floor, its floor plus the padding it actually gets, and a wide viewport. */
const COLUMN_WIDTHS = [
  { caption: "108px · the old column's content box", width: 108 },
  { caption: "128px · this column's content box", width: 128 },
  { caption: "300px · a wide viewport", width: 300 },
];

const LONGEST: PrPipelineStatus = {
  kind: "checkpoint",
  summary: summary({
    tone: "critical",
    label: "Checkpoint failed",
    reason: "12 couldn't confirm",
    executionState: "pipeline_failed",
  }),
};

function Row({ caption, children }: { caption: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <span className="w-56 shrink-0 font-mono text-3xs uppercase tracking-widest text-text-secondary">{caption}</span>
      {children}
    </div>
  );
}

const meta = {
  title: "Components/PrStatusPill",
  component: PrStatusPill,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof PrStatusPill>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Every kind the union has, at both densities, with `none` shown the two ways its callers ask for it. */
export const AllStates: Story = {
  args: { status: { kind: "none" } },
  render: () => (
    <div className="flex flex-col gap-6 bg-surface-void p-8">
      <div className="flex flex-col gap-2">
        <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Compact</span>
        {EVERY_STATUS.map(({ caption, status }) => (
          <Row key={caption} caption={caption}>
            <PrStatusPill status={status} empty="dash" />
          </Row>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">Comfortable</span>
        {EVERY_STATUS.map(({ caption, status }) => (
          <Row key={caption} caption={caption}>
            <PrStatusPill status={status} density="comfortable" empty="dash" />
          </Row>
        ))}
      </div>

      <div className="flex flex-col gap-2">
        <span className="font-mono text-2xs uppercase tracking-widest text-text-secondary">
          `none`, rendered both ways
        </span>
        <Row caption="empty=hide · headers">
          <PrStatusPill status={{ kind: "none" }} />
          <span className="font-mono text-3xs text-text-secondary">(nothing)</span>
        </Row>
        <Row caption="empty=dash · list cell">
          <PrStatusPill status={{ kind: "none" }} empty="dash" />
        </Row>
      </div>
    </div>
  ),
};

/**
 * The regression guard for the truncated badge.
 *
 * At every width the label stays whole until the reason has given up all of its space, and the pill never paints
 * outside its box. The 108px row is the width the old 140px column actually gave its contents, where the label
 * used to escape and overlap the column beside it.
 */
export const Truncation: Story = {
  args: { status: LONGEST },
  render: () => (
    <div className="flex flex-col gap-6 bg-surface-void p-8">
      {COLUMN_WIDTHS.map(({ caption, width }) => (
        <div key={width} className="flex flex-col gap-2">
          <span className="font-mono text-3xs uppercase tracking-widest text-text-secondary">{caption}</span>
          <div className="flex border border-dashed border-border-mid" style={{ width }}>
            <PrStatusPill status={LONGEST} />
          </div>
        </div>
      ))}
    </div>
  ),
};
