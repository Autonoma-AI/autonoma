import { Badge, cn, StatusDot } from "@autonoma/blacklight";
import type { PreviewLivenessState } from "lib/query/preview-access.queries";

// Runtime power/health, worded honestly: a preview that built fine but has since
// scaled to zero is "Idle", not "Ready". Derived from the cluster's live workload
// state (packages/k8s), NOT the deploy status - the deploy can be a success while
// the preview is fast asleep.
const LIVENESS_META = {
  healthy: { label: "Live", dot: "success", badge: "success", className: "" },
  waking: { label: "Waking", dot: "warn", badge: "status-running", className: "" },
  asleep: { label: "Idle", dot: "neutral", badge: "outline", className: "text-text-secondary" },
  error: { label: "Crashing", dot: "critical", badge: "status-failed", className: "" },
} as const;

/**
 * A badge for a preview's live runtime state. Renders nothing for "unknown"
 * (liveness not configured, preview torn down, or not one of ours), so it simply
 * disappears where there's nothing truthful to say rather than showing a guess.
 */
export function PreviewLivenessBadge({ state, className }: { state: PreviewLivenessState; className?: string }) {
  if (state === "unknown") return null;
  const meta = LIVENESS_META[state];
  return (
    <Badge
      variant={meta.badge}
      // Pin size + font so every state matches: the colored status variants are
      // 9-10px mono, but the neutral "outline" used for Idle inherits the base
      // text-xs and renders visibly larger otherwise.
      className={cn("shrink-0 gap-1 font-mono text-[10px] uppercase", meta.className, className)}
    >
      <StatusDot status={meta.dot} className="rounded-full" />
      {meta.label}
    </Badge>
  );
}
