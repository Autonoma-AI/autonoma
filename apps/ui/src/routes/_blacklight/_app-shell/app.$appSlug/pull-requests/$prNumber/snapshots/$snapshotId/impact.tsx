import { createFileRoute } from "@tanstack/react-router";
import { AnalysisImpactStage } from "components/analysis/analysis-impact-stage";
import { NotAnalyzedNote, isSelectionPending } from "components/analysis/stage-empty-states";
import { useAnalysisJob, useAnalysisRun } from "lib/query/branches.queries";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/impact",
)({
  component: ImpactStagePage,
});

function ImpactStagePage() {
  const { snapshotId } = Route.useParams();
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: run } = useAnalysisRun(snapshotId, { jobStatus: job?.status });

  if (run == null) {
    return <NotAnalyzedNote />;
  }
  return <AnalysisImpactStage run={run} reasoning={job?.impactReasoning} selectionPending={isSelectionPending(job)} />;
}
