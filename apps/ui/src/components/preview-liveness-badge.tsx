import { cn } from "@autonoma/blacklight";
import { PREVIEW_STATUS_HELP, PreviewStatusBadge } from "components/preview-status-badge";
import type { PreviewLivenessState } from "lib/query/preview-access.queries";

// Runtime power/health, worded honestly: a preview that built fine but has since
// scaled to zero is "Idle", not "Ready". Derived from the cluster's live workload
// state (packages/k8s), NOT the deploy status - the deploy can be a success while
// the preview is fast asleep. The (i) tooltip copy lives in the shared
// PREVIEW_STATUS_HELP registry, keyed by `label`.
const LIVENESS_META = {
  healthy: { label: "Live", badge: "success", className: "" },
  waking: { label: "Waking", badge: "status-running", className: "" },
  asleep: { label: "Idle", badge: "outline", className: "text-text-secondary" },
  error: { label: "Crashing", badge: "status-failed", className: "" },
} as const;

/**
 * A badge for a preview's live runtime state, with an (i) tooltip explaining what
 * the state means. Renders nothing for "unknown" (liveness not configured,
 * preview torn down, or not one of ours), so it simply disappears where there's
 * nothing truthful to say rather than showing a guess.
 */
export function PreviewLivenessBadge({ state, className }: { state: PreviewLivenessState; className?: string }) {
  if (state === "unknown") return null;
  const meta = LIVENESS_META[state];
  return (
    <PreviewStatusBadge
      label={meta.label}
      variant={meta.badge}
      help={PREVIEW_STATUS_HELP[meta.label]}
      className={cn(meta.className, className)}
    />
  );
}
