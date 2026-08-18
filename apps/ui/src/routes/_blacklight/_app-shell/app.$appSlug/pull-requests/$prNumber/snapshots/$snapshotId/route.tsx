import { Skeleton } from "@autonoma/blacklight";
import { ArrowLeftIcon } from "@phosphor-icons/react/ArrowLeft";
import { Outlet, createFileRoute, notFound, useMatchRoute } from "@tanstack/react-router";
import { AnalysisJobStatus } from "components/analysis/analysis-job-status";
import { AnalysisStageTabs, deriveAnalysisStage } from "components/analysis/analysis-stage-tabs";
import { SnapshotReportHeader } from "components/snapshot/snapshot-report-header";
import {
  ensureAnalysisJobData,
  ensureAnalysisReportData,
  ensureAnalysisRunData,
  ensureAnalysisSnapshotIssueChangesData,
  ensureFullSnapshotDetailData,
  ensureSnapshotReportData,
  useAnalysisJob,
  useAnalysisReport,
  useAnalysisRun,
  useSnapshotReport,
} from "lib/query/branches.queries";
import { Suspense } from "react";
import { AppLink } from "routes/_blacklight/_app-shell/-app-link";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId",
)({
  loader: async ({ context, params: { appSlug, snapshotId } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    // Every prefetch here is keyed by snapshotId, so httpBatchLink coalesces them into one HTTP request. The branch's
    // issues (branch-keyed, needed only by the report prose) are deliberately left out: they resolve post-mount inside
    // the prose's own Suspense boundary rather than blocking the route on a second, dependent round-trip.
    await Promise.all([
      ensureSnapshotReportData(context.queryClient, snapshotId),
      ensureFullSnapshotDetailData(context.queryClient, snapshotId),
      ensureAnalysisJobData(context.queryClient, snapshotId),
      ensureAnalysisRunData(context.queryClient, snapshotId),
      ensureAnalysisReportData(context.queryClient, snapshotId),
      ensureAnalysisSnapshotIssueChangesData(context.queryClient, snapshotId),
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
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: run } = useAnalysisRun(snapshotId, { jobStatus: job?.status });
  const { data: analysisReport } = useAnalysisReport(snapshotId, { jobStatus: job?.status });
  const matchRoute = useMatchRoute();
  // The full-screen finding page owns the whole screen (its own header + back link); when it is the active leaf,
  // render only its Outlet so it is not wrapped in the stage chrome.
  const onFindingDetail = matchRoute({
    to: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings",
    params: { appSlug, prNumber, snapshotId },
    fuzzy: true,
  });
  if (onFindingDetail) return <Outlet />;

  return (
    <div className="flex flex-col gap-6">
      <SnapshotReportHeader report={report} prNumber={prNumber} snapshotId={snapshotId} />

      {job?.status === "failed" ? (
        // A failed run has no stages to walk - it shows why it failed.
        <AnalysisJobStatus job={job} />
      ) : (
        <>
          <AnalysisStageTabs
            prNumber={prNumber}
            snapshotId={snapshotId}
            currentStage={deriveAnalysisStage(run, analysisReport != null)}
            jobRunning={job?.status === "running"}
          />
          <Outlet />
        </>
      )}
    </div>
  );
}

function PageSkeleton({ prNumber }: { prNumber: number }) {
  return (
    <div className="flex flex-col gap-6">
      <header className="space-y-3">
        <div className="flex items-center gap-2 text-text-secondary">
          <AppLink
            to="/app/$appSlug/pull-requests/$prNumber"
            params={{ prNumber }}
            aria-label="Back to pull request"
            className="inline-flex size-5 shrink-0 items-center justify-center rounded text-text-secondary transition-colors hover:bg-surface-raised hover:text-text-primary"
          >
            <ArrowLeftIcon size={12} />
          </AppLink>
          <Skeleton className="h-3 w-24" />
        </div>
        <Skeleton className="h-8 w-96" />
        <Skeleton className="h-5 w-160 max-w-full" />
      </header>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
