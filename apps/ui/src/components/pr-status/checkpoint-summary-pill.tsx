import type { CheckpointPresentationSummary } from "@autonoma/types";
import { PrStatusPill } from "./pr-status-pill";

interface CheckpointSummaryPillProps {
  summary: CheckpointPresentationSummary;
  density?: "compact" | "comfortable";
  className?: string;
}

/**
 * A checkpoint summary rendered as the same pill a PR's status uses, for the surfaces that hold a snapshot
 * rather than a branch - the checkpoint rail, snapshot report headers, the main-branch rows. A completed
 * analysis is the `checkpoint` arm of `PrPipelineStatus`, so this wraps rather than re-renders: there is one
 * markup for a status pill in the app, and it lives in `PrStatusPill`.
 */
export function CheckpointSummaryPill({ summary, density, className }: CheckpointSummaryPillProps) {
  return <PrStatusPill status={{ kind: "checkpoint", summary }} density={density} className={className} />;
}
