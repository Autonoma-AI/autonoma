import { Badge, StatusDot } from "@autonoma/blacklight";
import { CircleNotchIcon } from "@phosphor-icons/react/CircleNotch";
import { WarningOctagonIcon } from "@phosphor-icons/react/WarningOctagon";
import { formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";

type AnalysisJob = NonNullable<RouterOutputs["branches"]["analysisJob"]>;

/**
 * The running-snapshot fallback: an authoritative snapshot has an `AnalysisJob` but no `AnalysisReport` yet, so
 * there is no findings list to show. Render the run's lifecycle status instead. The PR page polls the report
 * while the job is running, so this flips to the findings list on its own once finalize writes the report.
 */
export function AnalysisJobStatus({ job }: { job: AnalysisJob }) {
  if (job.status === "failed") {
    return (
      <div className="flex flex-col items-center gap-3 border border-status-critical/40 bg-status-critical/5 px-6 py-12 text-center">
        <WarningOctagonIcon size={28} className="text-status-critical" />
        <div className="flex flex-col items-center gap-1">
          <p className="text-sm font-medium text-text-primary">Analysis failed for this checkpoint</p>
          <p className="max-w-prose text-sm text-text-secondary">
            {job.failureReason ?? "The analysis run ended before it could produce findings."}
          </p>
        </div>
      </div>
    );
  }

  if (job.status === "completed") {
    return (
      <div className="flex flex-col items-center gap-3 border border-border-dim bg-surface-base px-6 py-12 text-center">
        <StatusDot status="success" />
        <p className="text-sm font-medium text-text-primary">Analysis complete</p>
        <p className="max-w-prose text-sm text-text-secondary">No findings were recorded for this checkpoint.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-3 border border-border-dim bg-surface-base px-6 py-12 text-center">
      <CircleNotchIcon size={28} className="animate-spin text-primary" />
      <div className="flex flex-col items-center gap-1">
        <Badge variant="status-running" className="gap-1 font-mono uppercase tracking-wider">
          Analyzing
        </Badge>
        <p className="mt-1 text-sm font-medium text-text-primary">Testing this checkpoint</p>
        <p className="max-w-prose text-sm text-text-secondary">
          The agent is running the analysis pipeline. Findings will appear here as soon as the run completes.
        </p>
        {job.startedAt != null && (
          <span className="mt-1 font-mono text-2xs text-text-secondary">
            started {formatRelativeTime(job.startedAt)}
          </span>
        )}
      </div>
    </div>
  );
}
