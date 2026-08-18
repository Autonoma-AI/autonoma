import { Navigate, createFileRoute } from "@tanstack/react-router";
import { FindingDrawer } from "components/analysis/finding-drawer/finding-drawer";
import { FINDING_DRAWER_TABS } from "components/analysis/finding-drawer/finding-drawer-types";
import { ensureAnalysisFindingDetailData, useAnalysisFindingDetail, useAnalysisJob } from "lib/query/branches.queries";
import { z } from "zod";

const drawerSearchSchema = z
  .object({
    tab: z.enum(FINDING_DRAWER_TABS).optional(),
    iteration: z.coerce.number().int().positive().optional(),
  })
  .catch({});

export const Route = createFileRoute(
  "/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running/finding/$findingId",
)({
  validateSearch: (search) => drawerSearchSchema.parse(search),
  loaderDeps: ({ search }) => ({ iteration: search.iteration }),
  loader: async ({ context, params, deps }) => {
    await ensureAnalysisFindingDetailData(context.queryClient, params.findingId, deps.iteration);
  },
  component: FindingDrawerPage,
});

function FindingDrawerPage() {
  const params = Route.useParams();
  const { snapshotId, findingId } = params;
  const { tab, iteration } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: view } = useAnalysisFindingDetail(findingId, { iteration, jobStatus: job?.status });

  const close = () =>
    void navigate({
      to: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running",
    });

  // An unknown finding (or a stale iteration) navigates back rather than rendering a dead panel - the list
  // behind the drawer is the recovery surface.
  if (view == null) {
    return (
      <Navigate to="/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running" params={params} replace />
    );
  }

  return (
    <FindingDrawer
      view={view}
      tab={tab}
      onTabChange={(next) => void navigate({ search: (prev) => ({ ...prev, tab: next }), replace: true })}
      onIterationChange={(next) =>
        void navigate({ search: (prev) => ({ ...prev, iteration: next, tab: undefined }), replace: true })
      }
      onClose={close}
    />
  );
}
