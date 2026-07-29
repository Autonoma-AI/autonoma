import { Button, cn, Panel, PanelBody, PanelHeader, PanelTitle, Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { GearSixIcon } from "@phosphor-icons/react/GearSix";
import { Outlet, createFileRoute, notFound, useLocation } from "@tanstack/react-router";
import { AnalysisJobStatus } from "components/analysis/analysis-job-status";
import { AnalysisReportBody } from "components/analysis/analysis-report-body";
import { SentryLogsLink, TemporalLink } from "components/observability-links";
import type { SnapshotDetail } from "components/snapshot/diffs-timeline-types";
import { PipelineStrip } from "components/snapshot/pipeline-strip";
import { ReasoningPanel } from "components/snapshot/reasoning-panel";
import { SnapshotReportDocument, SnapshotReportDocumentSkeleton } from "components/snapshot/report-document";
import { SnapshotReportHeader } from "components/snapshot/snapshot-report-header";
import { SnapshotReportTabs } from "components/snapshot/snapshot-report-tabs";
import { SuiteChangesSummary } from "components/snapshot/suite-changes-summary";
import { useAuth } from "lib/auth";
import {
  ensureAnalysisIssuesData,
  ensureAnalysisJobData,
  ensureAnalysisReportData,
  ensureSnapshotDetailData,
  ensureSnapshotReportData,
  FULL_SNAPSHOT_DETAIL,
  useAnalysisJob,
  useAnalysisReport,
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
    const [, , , analysisReport] = await Promise.all([
      ensureSnapshotReportData(context.queryClient, snapshotId),
      ensureSnapshotDetailData(context.queryClient, snapshotId, FULL_SNAPSHOT_DETAIL),
      ensureAnalysisJobData(context.queryClient, snapshotId),
      ensureAnalysisReportData(context.queryClient, snapshotId),
    ]);
    // The report prose resolves its `issue:` tokens against the whole BRANCH's issues - it is PR-cumulative, so it
    // routinely references issues with no finding in this run. Keyed by branch, which only the report can tell us,
    // hence a second step rather than another entry above.
    if (analysisReport != null) {
      await ensureAnalysisIssuesData(context.queryClient, analysisReport.branchId);
    }
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
  // The `AnalysisJob` (null for a diffs snapshot) is the page-level gate: its presence means the merged pipeline
  // ran, so render the authoritative layout even before a report exists. The report supplies the content once it
  // lands and polls until then (driven by the job's status); while it is still null the run's lifecycle status
  // stands in. Both are prefetched in the loader, so neither flashes.
  const { data: analysisJob } = useAnalysisJob(snapshotId);
  const { data: analysisReport } = useAnalysisReport(snapshotId, { jobStatus: analysisJob?.status });
  const { isAdmin } = useAuth();
  const location = useLocation();
  const activeTab = location.pathname.includes("/changes") ? "changes" : "report";
  const showingChanges = activeTab === "changes";
  // The investigation + analysis finding-detail pages own the full screen (their own header + back link), so
  // render only their Outlet.
  const showingInvestigation = location.pathname.includes("/investigation");
  const showingFindings = location.pathname.includes("/findings");
  const [pipelineOpen, setPipelineOpen] = useState(false);
  const { changes, createdTests, diffsJob, refinementLoop } = detail;
  const isAuthoritative = analysisJob != null;

  if (showingInvestigation || showingFindings) return <Outlet />;

  const adminControls = isAdmin ? (
    <div className="flex items-center gap-2">
      {!isAuthoritative && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setPipelineOpen((prev) => !prev)}
          aria-expanded={pipelineOpen}
        >
          <GearSixIcon size={14} />
          {pipelineOpen ? "Hide pipeline" : "Show pipeline"}
        </Button>
      )}
      {diffsJob?.temporalWorkflow != null && (
        <TemporalLink workflowId={diffsJob.temporalWorkflow.workflowId} runId={diffsJob.temporalWorkflow.runId} />
      )}
      <SentryLogsLink filterField="snapshotId" filterValue={snapshotId} />
    </div>
  ) : undefined;

  return (
    <div className={cn("flex flex-col gap-6", showingChanges && "lg:h-full")}>
      <SnapshotReportHeader report={report} prNumber={prNumber} snapshotId={snapshotId} adminControls={adminControls} />

      <SnapshotReportTabs appSlug={appSlug} prNumber={prNumber} snapshotId={snapshotId} activeTab={activeTab} />

      {showingChanges ? (
        <div className="flex flex-col lg:min-h-0 lg:flex-1">
          <Outlet />
        </div>
      ) : analysisJob != null ? (
        analysisReport != null ? (
          <div className="flex flex-col gap-6">
            <AnalysisReportBody report={analysisReport} prNumber={prNumber} snapshotId={snapshotId} />
            {isAdmin && analysisReport.impactReasoning != null && (
              <ReasoningPanel
                title="Impact analysis"
                content={analysisReport.impactReasoning}
                empty="Analysis has not produced a selection summary yet."
              />
            )}
          </div>
        ) : (
          <AnalysisJobStatus job={analysisJob} />
        )
      ) : (
        <SnapshotReportBody report={report} detail={detail} prNumber={prNumber} />
      )}

      {isAdmin && diffsJob != null && pipelineOpen && (
        <PipelineStrip
          diffsJob={diffsJob}
          changes={changes}
          createdTests={createdTests}
          refinementLoop={refinementLoop}
          snapshotId={report.snapshot.id}
        />
      )}
    </div>
  );
}

function SnapshotReportBody({
  report,
  detail,
  prNumber,
}: {
  report: SnapshotReport;
  detail: SnapshotDetail;
  prNumber: number;
}) {
  return (
    <div className="flex flex-col gap-6">
      <SuiteChangesSummary detail={detail} prNumber={prNumber} />
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
        <CheckpointTestsRun
          executedTests={detail.executedTests}
          totalTests={detail.healthCounts.totalTests}
          executionState={detail.summary?.executionState}
        />
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
