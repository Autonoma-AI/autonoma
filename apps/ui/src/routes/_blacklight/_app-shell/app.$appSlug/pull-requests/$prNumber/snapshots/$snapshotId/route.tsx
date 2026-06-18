import {
  Badge,
  Button,
  cn,
  Panel,
  PanelBody,
  PanelHeader,
  PanelTitle,
  Skeleton,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { CameraIcon } from "@phosphor-icons/react/Camera";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { Link, Outlet, createFileRoute, notFound, useLocation } from "@tanstack/react-router";
import { SentryLogsLink, TemporalLink } from "components/observability-links";
import type { SnapshotDetail } from "components/snapshot/diffs-timeline-types";
import { PipelineStrip } from "components/snapshot/pipeline-strip";
import { SnapshotReportDocument, SnapshotReportDocumentSkeleton } from "components/snapshot/report-document";
import { ShaRange } from "components/snapshot/sha-range";
import { useAuth } from "lib/auth";
import { formatDuration, formatRelativeTime } from "lib/format";
import {
  ensureSnapshotDetailData,
  ensureSnapshotReportData,
  FULL_SNAPSHOT_DETAIL,
  useSnapshotDetail,
  useSnapshotReport,
} from "lib/query/branches.queries";
import type { RouterOutputs } from "lib/trpc";
import { Suspense, useState } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";
import { CheckpointTestsRun } from "../../../-components/checkpoint-tests-run";

type SnapshotReport = RouterOutputs["branches"]["snapshotReport"];

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId",
)({
  loader: async ({ context, params: { appSlug, snapshotId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    await Promise.all([
      ensureSnapshotReportData(context.queryClient, snapshotId),
      ensureSnapshotDetailData(context.queryClient, snapshotId, FULL_SNAPSHOT_DETAIL),
    ]);
  },
  component: SnapshotReportLayout,
});

function SnapshotReportLayout() {
  const { prNumber, snapshotId } = Route.useParams();

  return (
    <Suspense fallback={<PageSkeleton prNumber={prNumber} />}>
      <SnapshotReportContent prNumber={prNumber} snapshotId={snapshotId} />
    </Suspense>
  );
}

function SnapshotReportContent({ prNumber, snapshotId }: { prNumber: number; snapshotId: string }) {
  const { appSlug } = Route.useParams();
  const { data: report } = useSnapshotReport(snapshotId);
  const { data: detail } = useSnapshotDetail(snapshotId, FULL_SNAPSHOT_DETAIL);
  const { isAdmin } = useAuth();
  const bugCount = report.bugs.length;
  const location = useLocation();
  const activeTab = location.pathname.includes("/changes") ? "changes" : "report";
  const showingChanges = activeTab === "changes";
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const { changes, diffsJob, refinementLoop } = detail;

  return (
    <div className={cn("flex flex-col gap-6", showingChanges && "lg:h-full")}>
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
            <Badge variant={healthVariant(report.health)} className="font-mono uppercase">
              {report.health}
              {bugCount > 0 ? ` · ${bugCount} ${bugCount === 1 ? "bug" : "bugs"}` : ""}
            </Badge>
            {isAdmin && (
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPipelineOpen((prev) => !prev)}
                  aria-expanded={pipelineOpen}
                >
                  <GearSixIcon size={14} />
                  {pipelineOpen ? "Hide pipeline" : "Show pipeline"}
                </Button>
                {diffsJob.temporalWorkflow != null && (
                  <TemporalLink
                    workflowId={diffsJob.temporalWorkflow.workflowId}
                    runId={diffsJob.temporalWorkflow.runId}
                  />
                )}
                <SentryLogsLink filterField="snapshotId" filterValue={report.snapshot.id} />
              </div>
            )}
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
          {report.results.running > 0 && <span>{report.results.running} running</span>}
          {report.results.pending > 0 && <span>{report.results.pending} pending</span>}
          <span>commit range:</span>
          <ShaRange baseSha={report.snapshot.baseSha ?? null} headSha={report.snapshot.headSha ?? null} />
        </div>
      </header>

      <Tabs value={activeTab} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger
            value="report"
            render={
              <Link
                to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId"
                params={{ appSlug, prNumber, snapshotId }}
              />
            }
          >
            Checkpoint report
          </TabsTrigger>
          <TabsTrigger
            value="changes"
            render={
              <Link
                to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/changes"
                params={{ appSlug, prNumber, snapshotId }}
              />
            }
          >
            Test suite changes
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {showingChanges ? (
        <div className="flex flex-col lg:min-h-0 lg:flex-1">
          <Outlet />
        </div>
      ) : (
        <SnapshotReportBody report={report} detail={detail} />
      )}

      {isAdmin && pipelineOpen && (
        <PipelineStrip
          diffsJob={diffsJob}
          changes={changes}
          refinementLoop={refinementLoop}
          snapshotId={report.snapshot.id}
        />
      )}
    </div>
  );
}

function SnapshotReportBody({ report, detail }: { report: SnapshotReport; detail: SnapshotDetail }) {
  return (
    <div className="flex flex-col gap-6">
      <TestsRunPanel detail={detail} />
      <SnapshotReportDocument report={report} />
    </div>
  );
}

function TestsRunPanel({ detail }: { detail: SnapshotDetail }) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>Tests run</PanelTitle>
      </PanelHeader>
      <PanelBody>
        <CheckpointTestsRun executedTests={detail.executedTests} totalTests={detail.healthCounts.totalTests} />
      </PanelBody>
    </Panel>
  );
}

function PageSkeleton({ prNumber }: { prNumber: number }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-text-tertiary">
          <AppLink
            to="/app/$appSlug/pull-requests/$prNumber"
            params={{ prNumber }}
            aria-label="Back to pull request"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <ArrowLeftIcon size={12} />
          </AppLink>
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-5 w-160 max-w-full" />
      </header>
      <SnapshotReportDocumentSkeleton />
    </div>
  );
}

function healthVariant(health: string): "success" | "critical" | "status-running" | "outline" {
  if (health === "healthy") return "success";
  if (health === "critical") return "critical";
  if (health === "running") return "status-running";
  return "outline";
}
