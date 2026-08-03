import { Skeleton } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { useOnboardingState } from "lib/onboarding/onboarding-api";
import { toPageParam } from "lib/page-param";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { ensureMainOpenProblemsData } from "lib/query/branches.queries";
import { ensureLatestPullRequestsData } from "lib/query/latest-prs.queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { FinishSetupPrompt } from "./-home/finish-setup-prompt";
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
      ensureAPIQueryData(context.queryClient, trpc.onboarding.getState.queryOptions({ applicationId: app.id })),
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
        <HomeBody appId={app.id} appSlug={app.slug} appName={app.name} />
      </Suspense>
    </div>
  );
}

/**
 * Until the three compulsory finish-setup steps are done, Home leads with the
 * Finish setup prompt instead of the PR list / problems rail - Autonoma can't run
 * test generations without them.
 */
function HomeBody({ appId, appSlug, appName }: { appId: string; appSlug: string; appName: string }) {
  const { data: state } = useOnboardingState(appId);
  const { prs = 1 } = Route.useSearch();
  const navigate = Route.useNavigate();

  if (!state.setupComplete) {
    return (
      <FinishSetupPrompt
        appName={appName}
        appSlug={appSlug}
        sdkConfigured={state.sdkConfigured}
        artifactsUploaded={state.artifactsUploaded}
        dryRunPassed={state.dryRunPassed}
      />
    );
  }

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
