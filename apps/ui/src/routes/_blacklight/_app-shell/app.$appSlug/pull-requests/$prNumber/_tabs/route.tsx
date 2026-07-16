import { Skeleton } from "@autonoma/blacklight";
import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchByPrData, ensurePrPipelineStatusData } from "lib/query/branches.queries";
import { ensurePreviewEnvironmentSummaryData } from "lib/query/deployments.queries";
import { Suspense } from "react";
import { PRPageHeader } from "../../-components/pr-page-header";

// Layout for the PR's tab pages (Overview + Preview). Renders the shared header + tab bar once and
// hosts the tab bodies in the Outlet, so switching tabs swaps only the body - the header is never
// remounted. Pathless (`_tabs`), so it does not add a URL segment and does not wrap the PR's
// drill-down routes (snapshots, suite), which own their own headers.
export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/pull-requests/$prNumber/_tabs")({
  loader: async ({ context, params: { appSlug, prNumber } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    const branch = await ensureBranchByPrData(context.queryClient, app.id, prNumber);
    await Promise.all([
      ensurePreviewEnvironmentSummaryData(context.queryClient, app.id, prNumber),
      ensurePrPipelineStatusData(context.queryClient, app.id, branch.id),
    ]);
  },
  component: PRTabsLayout,
});

function PRTabsLayout() {
  const { prNumber } = Route.useParams();

  return (
    <div className="-m-6 flex min-h-full flex-col">
      <Suspense fallback={<PRHeaderSkeleton />}>
        <PRPageHeader prNumber={prNumber} />
      </Suspense>
      <Outlet />
    </div>
  );
}

function PRHeaderSkeleton() {
  return (
    <>
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-36 w-full" />
    </>
  );
}
