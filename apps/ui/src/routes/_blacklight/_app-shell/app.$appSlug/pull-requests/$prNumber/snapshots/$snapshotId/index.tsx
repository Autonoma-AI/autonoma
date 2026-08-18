import { createFileRoute, redirect } from "@tanstack/react-router";
import { STAGE_ROUTES, deriveAnalysisStage } from "components/analysis/analysis-stage-tabs";
import { ensureAnalysisReportData, ensureAnalysisRunData } from "lib/query/branches.queries";

/**
 * The bare snapshot URL lands on whatever stage the run is at - once, at load. Navigation never moves again on
 * its own after that: the stage tabs are plain links and the URL is the only thing that picks a stage.
 */
export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/",
)({
  loader: async ({ context, params }) => {
    const [run, report] = await Promise.all([
      ensureAnalysisRunData(context.queryClient, params.snapshotId),
      ensureAnalysisReportData(context.queryClient, params.snapshotId),
    ]);
    const stage = deriveAnalysisStage(run, report != null);
    throw redirect({ to: STAGE_ROUTES[stage], params, replace: true });
  },
});
