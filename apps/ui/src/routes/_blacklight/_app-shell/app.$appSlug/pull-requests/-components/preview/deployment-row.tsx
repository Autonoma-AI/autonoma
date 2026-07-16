import { Badge, StatusDot, cn } from "@autonoma/blacklight";
import { CalendarBlankIcon } from "@phosphor-icons/react/CalendarBlank";
import { TimerIcon } from "@phosphor-icons/react/Timer";
import { formatDuration, formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";

export type DeploymentHistoryRow = RouterOutputs["deployments"]["history"][number];

// Status dot + pill tokens for a deployment row. `success`/`failed` are the dots the design calls
// out (--status-success / --status-critical via the StatusDot tokens); building/superseded reuse the
// neutral tones.
export const DEPLOYMENT_STATUS_META = {
  success: { label: "Success", dot: "success", badge: "success", className: "" },
  building: { label: "Building", dot: "warn", badge: "status-running", className: "" },
  failed: { label: "Failed", dot: "critical", badge: "status-failed", className: "" },
  superseded: { label: "Superseded", dot: "neutral", badge: "outline", className: "text-text-secondary" },
} as const;

// One deployment (a pushed commit's build). The current deploy is rendered active - lime left-border
// + raised background - since it is the one whose logs the environment currently serves.
export function DeploymentRow({ deployment }: { deployment: DeploymentHistoryRow }) {
  const statusMeta = DEPLOYMENT_STATUS_META[deployment.status];

  return (
    <div
      className={cn(
        "flex flex-col gap-1.5 border-l-2 border-l-transparent px-4 py-2.5",
        deployment.isCurrent && "border-l-primary bg-surface-raised",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={statusMeta.dot} className="shrink-0 rounded-full" />
        <span className="font-mono text-sm text-text-primary">{deployment.headSha.slice(0, 7)}</span>
        {deployment.isCurrent && (
          <Badge variant="outline" className="shrink-0">
            Current
          </Badge>
        )}
        <Badge variant={statusMeta.badge} className={cn("ml-auto shrink-0 uppercase", statusMeta.className)}>
          {statusMeta.label}
        </Badge>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-4 font-mono text-2xs tabular-nums text-text-secondary">
        <span className="inline-flex items-center gap-1">
          <CalendarBlankIcon size={11} className="shrink-0" />
          {formatRelativeTime(deployment.startedAt)}
        </span>
        {deployment.durationMs != null && (
          <span className="inline-flex items-center gap-1">
            <TimerIcon size={11} className="shrink-0" />
            {formatDuration(deployment.durationMs)}
          </span>
        )}
      </div>
    </div>
  );
}
