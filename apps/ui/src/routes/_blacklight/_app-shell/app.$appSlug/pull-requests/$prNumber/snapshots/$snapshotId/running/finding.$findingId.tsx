import { Drawer, DrawerContent } from "@autonoma/blacklight";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { FindingDrawer, FindingDrawerSkeleton } from "components/analysis/finding-drawer/finding-drawer";
import { FINDING_DRAWER_TABS } from "components/analysis/finding-drawer/finding-drawer-types";
import { ensureAnalysisFindingDetailData, useAnalysisFindingDetail, useAnalysisJob } from "lib/query/branches.queries";
import { Suspense } from "react";
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
  // Fire-and-forget: warm the finding-detail cache without blocking navigation, so the drawer opens instantly and
  // its own Suspense boundary shows the skeleton while this resolves - rather than the whole run stage pending.
  loader: ({ context, params, deps }) => {
    void ensureAnalysisFindingDetailData(context.queryClient, params.findingId, deps.iteration);
  },
  component: FindingDrawerPage,
});

function FindingDrawerPage() {
  const navigate = Route.useNavigate();
  const close = () =>
    void navigate({
      to: "/app/$appSlug/pull-requests/$prNumber/snapshots/$snapshotId/running",
    });

  return (
    <Drawer side="right" modal={false} open onOpenChange={(open) => !open && close()}>
      <DrawerContent side="right" className="flex w-160 max-w-[95vw] flex-col gap-0 overflow-hidden p-0 font-sans">
        <Suspense fallback={<FindingDrawerSkeleton />}>
          <FindingDrawerContent />
        </Suspense>
      </DrawerContent>
    </Drawer>
  );
}

function FindingDrawerContent() {
  const params = Route.useParams();
  const { snapshotId, findingId } = params;
  const { tab, iteration } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data: job } = useAnalysisJob(snapshotId);
  const { data: view } = useAnalysisFindingDetail(findingId, { iteration, jobStatus: job?.status });

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
    />
  );
}
