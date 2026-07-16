import { Badge } from "@autonoma/blacklight";
import type { CheckpointTone, PrPipelineStatus } from "@autonoma/types";
import { CheckpointSummaryBadge } from "./checkpoint-summary-badge";
import { pipelinePillPresentation } from "./pr-pipeline-status-presentation";

type BadgeVariant = "status-passed" | "status-failed" | "status-running" | "status-pending";

const TONE_VARIANT: Record<CheckpointTone, BadgeVariant> = {
  success: "status-passed",
  critical: "status-failed",
  warning: "status-running",
  neutral: "status-pending",
};

// The branch's rolled-up pipeline status as a single header badge, matching the PR list pill so the
// list and the page never disagree. A completed analysis renders its checkpoint summary; the
// in-flight/superseded states render a labeled badge; `none` renders nothing.
export function PrStatusBadge({ status }: { status: PrPipelineStatus }) {
  if (status.kind === "checkpoint") return <CheckpointSummaryBadge summary={status.summary} />;

  const pill = pipelinePillPresentation(status.kind);
  if (pill == null) return undefined;

  return <Badge variant={TONE_VARIANT[pill.tone]}>{pill.label}</Badge>;
}
