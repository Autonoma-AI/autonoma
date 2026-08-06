import { Outlet, createFileRoute } from "@tanstack/react-router";
import { RouteErrorState } from "components/route-error-state";
import { ensureAnalysisReportData } from "lib/query/branches.queries";

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/findings",
)({
  loader: async ({ context, params: { snapshotId } }) => {
    await ensureAnalysisReportData(context.queryClient, snapshotId);
  },
  component: Outlet,
  // Absence is handled by the detail page itself (the report resolves to null, and the page renders a graceful
  // "not found" state). This boundary is the last-resort net for an UNEXPECTED failure (a network error) so the
  // finding view degrades to a calm retry instead of the app-wide "Something went wrong" crash screen.
  errorComponent: ({ reset }) => <RouteErrorState message="We couldn't load this finding." reset={reset} />,
});
