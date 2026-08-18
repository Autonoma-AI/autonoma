import { Outlet, createFileRoute } from "@tanstack/react-router";
import { AnalysisRunGroups } from "components/analysis/analysis-run-groups";
import { NotAnalyzedNote, isSelectionPending } from "components/analysis/stage-empty-states";
import { useAnalysisJob, useAnalysisRun } from "lib/query/branches.queries";

/** The running stage: the verdict-grouped test list, with the finding drawer as a child route overlaying it. */
export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running",
)({
  component: RunningStagePage,
});

function RunningStagePage() {
  const { prNumber, snapshotId } = Route.useParams();
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: run } = useAnalysisRun(snapshotId, { jobStatus: job?.status });

  if (run == null) {
    return <NotAnalyzedNote />;
  }
  return (
    <>
      <AnalysisRunGroups
        run={run}
        prNumber={prNumber}
        snapshotId={snapshotId}
        selectionPending={isSelectionPending(job)}
      />
      <Outlet />
    </>
  );
}
