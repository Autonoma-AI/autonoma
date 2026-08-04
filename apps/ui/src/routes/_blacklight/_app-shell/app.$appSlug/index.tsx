import { Skeleton } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { toPageParam } from "lib/page-param";
import { ensureMainOpenProblemsData } from "lib/query/branches.queries";
import { ensureLatestPullRequestsData } from "lib/query/latest-prs.queries";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { HomeHeader } from "./-home/home-header";
import { MainProblemsRail, MainProblemsRailSkeleton } from "./-home/main-problems-rail";
import { OpenPrsList, OpenPrsListSkeleton } from "./-home/open-prs-list";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/")({
  // `prs` rather than `page`: Home is one screen with several lists, so the param says which list it pages.
  // Optional, and omitted on page 1 - so every existing link to Home stays valid and the common URL stays clean.
  validateSearch: (search: Record<string, unknown>): { prs?: number } => {
    const page = toPageParam(search.prs);
    return page > 1 ? { prs: page } : {};
  },
  loaderDeps: ({ search: { prs } }) => ({ prs: prs ?? 1 }),
  loader: async ({ context, params: { appSlug }, deps: { prs } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    await Promise.all([
      ensureLatestPullRequestsData(context.queryClient, app.id, prs),
      ensureMainOpenProblemsData(context.queryClient, app.id),
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

      <Suspense fallback={<Skeleton className="m-6 flex-1" />}>
        <HomeBody />
      </Suspense>
    </div>
  );
}

function HomeBody() {
  const { prs = 1 } = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden px-6 py-5">
        {/* Keyed on the page so the list suspends to its skeleton while the next page loads, rather than
            holding the previous page's rows under a stale pager. */}
        <Suspense key={prs} fallback={<OpenPrsListSkeleton />}>
          <OpenPrsList page={prs} onPageChange={(next) => void navigate({ search: { prs: next }, replace: true })} />
        </Suspense>
      </div>

      <Suspense fallback={<MainProblemsRailSkeleton />}>
        <MainProblemsRail />
      </Suspense>
    </div>
  );
}
