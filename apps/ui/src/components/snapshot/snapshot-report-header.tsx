import { Badge } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CameraIcon } from "@phosphor-icons/react/Camera";
import { SentryLogsLink } from "components/observability-links";
import { CheckpointSummaryPill } from "components/pr-status/checkpoint-summary-pill";
import { useAuth } from "lib/auth";
import { formatDuration, formatRelativeTime } from "lib/format";
import type { RouterOutputs } from "lib/trpc";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { formatCheckpointMetrics } from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/format-checkpoint-metrics";
import { unresolvedLabel } from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/outcome-vocab";
import { ShaRange } from "./sha-range";

type SnapshotReport = RouterOutputs["branches"]["snapshotReport"];

/**
 * The snapshot-page header: title, health/summary badge, run stats, commit range, and - for admins - the
 * link into this snapshot's Sentry logs.
 */
export function SnapshotReportHeader({
  report,
  prNumber,
  snapshotId,
}: {
  report: SnapshotReport;
  prNumber: number;
  snapshotId: string;
}) {
  const { isAdmin } = useAuth();

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-text-tertiary">
        <AppLink
          to="/app/$appSlug/pull-requests/$prNumber"
          params={{ prNumber }}
          aria-label="Back to pull request"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
        >
          <ArrowLeftIcon size={12} />
        </AppLink>
        <CameraIcon size={14} />
        <span className="font-mono text-2xs uppercase tracking-widest">Report</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-medium tracking-tight text-text-primary">
            Here is what we just tested and what broke
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Checkpoint report for PR #{prNumber} on {report.snapshot.branch.name}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {report.summary != null ? (
            <CheckpointSummaryPill summary={report.summary} density="comfortable" />
          ) : (
            <Badge variant={healthVariant(report.health)} className="font-mono uppercase">
              {report.health}
            </Badge>
          )}
          {isAdmin && <SentryLogsLink filterField="snapshotId" filterValue={snapshotId} />}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
        <span>{formatRelativeTime(report.snapshot.createdAt)}</span>
        {/* An authoritative run states its outcome in the analysis vocabulary - bugs and coverage findings, via
            the shared metrics formatter the checkpoint rail and PR list also use - rather than the raw
            pass/fail tally a legacy snapshot reports. */}
        {report.summary?.analysis != null ? (
          <span>{formatCheckpointMetrics(report.summary, report.results.total)}</span>
        ) : (
          <DiffsResultStats report={report} />
        )}
        <span>commit range:</span>
        <ShaRange baseSha={report.snapshot.baseSha ?? null} headSha={report.snapshot.headSha ?? null} />
      </div>
    </header>
  );
}

function DiffsResultStats({ report }: { report: SnapshotReport }) {
  return (
    <>
      <span>{formatDuration(report.results.durationMs)}</span>
      <span>{report.results.total} tests run</span>
      <span>{report.results.passed} passed</span>
      <span className={report.results.failed > 0 ? "text-status-critical" : undefined}>
        {report.results.failed} failed
      </span>
      {report.results.setupFailed > 0 && (
        <span className="text-status-warn">{report.results.setupFailed} setup failed</span>
      )}
      {report.results.running > 0 && (
        <span>
          {report.results.running} {unresolvedLabel(report.summary?.executionState)}
        </span>
      )}
      {report.results.pending > 0 && <span>{report.results.pending} pending</span>}
    </>
  );
}

function healthVariant(health: string): "success" | "critical" | "status-running" | "outline" {
  if (health === "healthy") return "success";
  if (health === "critical") return "critical";
  if (health === "running") return "status-running";
  return "outline";
}
