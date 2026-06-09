import { createFileRoute } from "@tanstack/react-router";
import { ensureBugsListData } from "lib/query/bugs.queries";
import { ensureLatestPullRequestsData } from "lib/query/latest-prs.queries";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { HomeHeader } from "./-home/home-header";
import { OpenPrsList, OpenPrsListSkeleton } from "./-home/open-prs-list";
import { UnresolvedBugsRail, UnresolvedBugsRailSkeleton } from "./-home/unresolved-bugs-rail";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    await Promise.all([
      ensureLatestPullRequestsData(context.queryClient, app.id),
      ensureBugsListData(context.queryClient, app.id),
    ]);
  },
  component: HomePage,
});

function HomePage() {
  const app = useCurrentApplication();

  // `-m-6` + `h-[calc(100%+3rem)]` cancels the app-shell's p-6 so the page fills the
  // viewport exactly; the columns scroll internally instead of the whole page.
  return (
    <div className="-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden">
      <HomeHeader appName={app.name} architecture={app.architecture} />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-6 py-5">
          <Suspense fallback={<OpenPrsListSkeleton />}>
            <OpenPrsList />
          </Suspense>
        </div>

        <Suspense fallback={<UnresolvedBugsRailSkeleton />}>
          <UnresolvedBugsRail />
        </Suspense>
      </div>
    </div>
  );
}
