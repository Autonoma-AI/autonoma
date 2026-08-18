import { Navigate, createFileRoute } from "@tanstack/react-router";
import { RemovedTestDrawer } from "components/analysis/finding-drawer/removed-test-drawer";
import { useAnalysisJob, useAnalysisRun } from "lib/query/branches.queries";

/** The stub drawer for a PR-removed test: everything it shows already rides on the run view's stub row. */
export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running/removed/$testCaseId",
)({
  component: RemovedTestDrawerPage,
});

function RemovedTestDrawerPage() {
  const params = Route.useParams();
  const { snapshotId, testCaseId } = params;
  const navigate = Route.useNavigate();
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: run } = useAnalysisRun(snapshotId, { jobStatus: job?.status });
  const removed = run?.removedTests.find((candidate) => candidate.testCase.id === testCaseId);

  const close = () =>
    void navigate({
      to: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running",
    });

  if (removed == null) {
    return (
      <Navigate to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running" params={params} replace />
    );
  }
  return <RemovedTestDrawer removed={removed} onClose={close} />;
}
