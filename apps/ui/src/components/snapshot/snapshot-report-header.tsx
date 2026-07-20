import { Badge, Button } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CameraIcon } from "@phosphor-icons/react/Camera";
import { MagnifyingGlassIcon } from "@phosphor-icons/react/MagnifyingGlass";
import { formatDuration, formatRelativeTime } from "lib/format";
import { useInvestigationReport } from "lib/query/branches.queries";
import type { RouterOutputs } from "lib/trpc";
import type { ReactNode } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { CheckpointSummaryBadge } from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/checkpoint-summary-badge";
import { unresolvedLabel } from "routes/_blacklight/_app-shell/app.$appSlug/pull-requests/-components/outcome-vocab";
import { ShaRange } from "./sha-range";

type SnapshotReport = RouterOutputs["branches"]["snapshotReport"];

/**
 * The shared snapshot-page header (title, health/summary badge, run stats, commit range). Rendered identically
 * by both the diffs and authoritative page layouts; the mode-specific admin controls (diffs pipeline toggle +
 * Temporal link, or the analysis Sentry link) are passed in via `adminControls`.
 */
export function SnapshotReportHeader({
  report,
  prNumber,
  snapshotId,
  adminControls,
}: {
  report: SnapshotReport;
  prNumber: number;
  snapshotId: string;
  adminControls?: ReactNode;
}) {
  // Internal-only: the shadow investigation agent's report, for comparing against the deployed agent. The hook
  // is enabled only for @autonoma.app users, so `investigation` is undefined for everyone else.
  const { data: investigation } = useInvestigationReport(snapshotId);

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
            <CheckpointSummaryBadge summary={report.summary} />
          ) : (
            <Badge variant={healthVariant(report.health)} className="font-mono uppercase">
              {report.health}
            </Badge>
          )}
          {investigation != null && (
            <AppLink
              to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/investigation"
              params={{ prNumber, snapshotId }}
              aria-label="View the shadow investigation agent report"
            >
              <Button variant="outline" size="sm">
                <MagnifyingGlassIcon size={14} />
                Investigation
                {investigation.clientBugCount > 0
                  ? ` · ${investigation.clientBugCount} ${investigation.clientBugCount === 1 ? "bug" : "bugs"}`
                  : ""}
              </Button>
            </AppLink>
          )}
          {adminControls}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs text-text-tertiary">
        <span>{formatRelativeTime(report.snapshot.createdAt)}</span>
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
        <span>commit range:</span>
        <ShaRange baseSha={report.snapshot.baseSha ?? null} headSha={report.snapshot.headSha ?? null} />
      </div>
    </header>
  );
}

function healthVariant(health: string): "success" | "critical" | "status-running" | "outline" {
  if (health === "healthy") return "success";
  if (health === "critical") return "critical";
  if (health === "running") return "status-running";
  return "outline";
}
