import { Skeleton, cn } from "@autonoma/blacklight";
import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchByPrData, ensurePrPipelineStatusData } from "lib/query/branches.queries";
import { ensurePreviewEnvironmentSummaryData } from "lib/query/deployments.queries";
import { Suspense } from "react";
import { APP_SHELL_GUTTER } from "routes/_blacklight/_app-shell/-layout/app-shell-gutter";
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
  // Without this the layout's own wait escapes past the app shell, so the sidebar goes with it. The header
  // is the only thing this route owns; the Outlet's body brings its own pending state.
  pendingComponent: PRTabsPending,
  component: PRTabsLayout,
});

function PRTabsPending() {
  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      <PRHeaderSkeleton />
    </div>
  );
}

function PRTabsLayout() {
  const { prNumber } = Route.useParams();

  return (
    // Cancels the app-shell's padding so the page fills the viewport exactly; the Preview tab's panels
    // scroll internally instead of the whole page. The negative margin comes from the same module as the
    // padding it undoes - hand-written, they drifted apart the moment the gutter changed and left a gap
    // nothing failed on. The Outlet is wrapped in its own flex/scroll region rather than left bare so the
    // Overview tab (which has no bounded-height content of its own) keeps scrolling as it does today.
    <div className={cn("flex flex-col overflow-hidden", APP_SHELL_GUTTER.bleed)}>
      <Suspense fallback={<PRHeaderSkeleton />}>
        <PRPageHeader prNumber={prNumber} />
      </Suspense>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Outlet />
      </div>
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
