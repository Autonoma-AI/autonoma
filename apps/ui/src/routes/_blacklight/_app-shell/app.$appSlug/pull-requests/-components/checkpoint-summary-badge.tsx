import { Badge, cn } from "@autonoma/blacklight";
import type { CheckpointPresentationSummary, CheckpointTone } from "@autonoma/types";

type BadgeVariant = "status-passed" | "status-failed" | "status-running" | "status-pending";

// Tone picks the badge color.
const TONE_VARIANT: Record<CheckpointTone, BadgeVariant> = {
  success: "status-passed",
  critical: "status-failed",
  warning: "status-running",
  neutral: "status-pending",
};

/**
 * Single badge for a checkpoint/PR derived `summary`, used by the PR list and the PR detail header.
 * The label and reason stay on one line (the Badge is `whitespace-nowrap`); reason is a secondary,
 * labeled count (e.g. occurrences).
 */
export function CheckpointSummaryBadge({
  summary,
  className,
}: {
  summary: CheckpointPresentationSummary;
  className?: string;
}) {
  return (
    <Badge variant={TONE_VARIANT[summary.tone]} className={cn("gap-1.5", className)}>
      <span>{summary.label}</span>
      {summary.reason != null && (
        <>
          <span aria-hidden className="opacity-50">
            ·
          </span>
          <span className="font-normal normal-case opacity-80">{summary.reason}</span>
        </>
      )}
    </Badge>
  );
}
