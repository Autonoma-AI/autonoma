import { createFileRoute } from "@tanstack/react-router";
import { AnalysisReportBody } from "components/analysis/analysis-report-body";
import { useAnalysisJob, useAnalysisReport } from "lib/query/branches.queries";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/report",
)({
  component: ReportStagePage,
});

function ReportStagePage() {
  const { prNumber, snapshotId } = Route.useParams();
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: report } = useAnalysisReport(snapshotId, { jobStatus: job?.status });

  if (report == null) {
    return (
      <p className="rounded-lg border border-border-dim bg-surface-void px-5 py-6 text-sm text-text-secondary">
        The report will appear here once the run settles.
      </p>
    );
  }
  return <AnalysisReportBody report={report} prNumber={prNumber} snapshotId={snapshotId} />;
}
