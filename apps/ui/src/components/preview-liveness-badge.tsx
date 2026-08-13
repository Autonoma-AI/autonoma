import { cn } from "@autonoma/blacklight";
import { PREVIEW_STATUS_HELP, PreviewStatusBadge } from "components/preview-status-badge";
import type { PreviewLivenessState } from "lib/query/preview-access.queries";

// Runtime power/health, worded honestly: a preview that built fine but has since
// scaled to zero is "Idle", not "Ready". Derived from the cluster's live workload
// state (packages/k8s), NOT the deploy status - the deploy can be a success while
// the preview is fast asleep. The (i) tooltip copy lives in the shared
// PREVIEW_STATUS_HELP registry, keyed by `label`.
const LIVENESS_META = {
  healthy: { label: "Live", badge: "success", className: "", dot: "bg-status-success", row: "text-text-secondary" },
  waking: {
    label: "Waking",
    badge: "status-running",
    className: "",
    dot: "bg-status-warn",
    row: "text-text-secondary",
  },
  asleep: {
    label: "Idle",
    badge: "outline",
    className: "text-text-secondary",
    dot: "bg-text-secondary",
    row: "text-text-secondary",
  },
  error: {
    label: "Crashing",
    badge: "status-failed",
    className: "",
    dot: "bg-status-critical",
    row: "text-status-critical",
  },
} as const;

/**
 * A preview's live runtime state.
 *
 * `badge` is the headline treatment for the PR's Preview tab, where this is what the reader came to see: a
 * coloured badge with an (i) tooltip explaining what the state means.
 *
 * `row` is for a list, where it is one of several things on a line and where "Live" is the ordinary case. It
 * keeps the same word and the same colour, carried by a dot, so a crashing preview still stands out among
 * twenty-five healthy ones instead of being lost in a column of badges. The explanation lives on the tab.
 *
 * Renders nothing for "unknown" (liveness not configured, preview torn down, or not one of ours), so it simply
 * disappears where there's nothing truthful to say rather than showing a guess.
 */
export function PreviewLivenessBadge({
  state,
  weight = "badge",
  className,
}: {
  state: PreviewLivenessState;
  weight?: "badge" | "row";
  className?: string;
}) {
  if (state === "unknown") return null;
  const meta = LIVENESS_META[state];

  if (weight === "row") {
    return (
      <span className={cn("inline-flex min-w-0 items-center gap-1.5 font-mono text-2xs", meta.row, className)}>
        <span className={cn("size-1.5 shrink-0", meta.dot)} />
        <span className="truncate">{meta.label}</span>
      </span>
    );
  }

  return (
    <PreviewStatusBadge
      label={meta.label}
      variant={meta.badge}
      help={PREVIEW_STATUS_HELP[meta.label]}
      className={cn(meta.className, className)}
    />
  );
}
