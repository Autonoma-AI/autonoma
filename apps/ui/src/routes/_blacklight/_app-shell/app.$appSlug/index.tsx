import { Skeleton } from "@autonoma/blacklight";
import { createFileRoute } from "@tanstack/react-router";
import { useOnboardingState } from "lib/onboarding/onboarding-api";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { ensureBugsSummaryData } from "lib/query/bugs.queries";
import { ensureLatestPullRequestsData } from "lib/query/latest-prs.queries";
import { trpc } from "lib/trpc";
import { Suspense } from "react";
import { useCurrentApplication } from "routes/_blacklight/_app-shell/-use-current-application";
import { FinishSetupPrompt } from "./-home/finish-setup-prompt";
import { HomeHeader } from "./-home/home-header";
import { OpenPrsList, OpenPrsListSkeleton } from "./-home/open-prs-list";
import { UnresolvedBugsRail, UnresolvedBugsRailSkeleton } from "./-home/unresolved-bugs-rail";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug/")({
  loader: async ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) return;
    await Promise.all([
      ensureLatestPullRequestsData(context.queryClient, app.id),
      ensureBugsSummaryData(context.queryClient, app.id),
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
 * Finish setup prompt instead of the PR list / bugs rail - Autonoma can't run
 * test generations without them.
 */
function HomeBody({ appId, appSlug, appName }: { appId: string; appSlug: string; appName: string }) {
  const { data: state } = useOnboardingState(appId);

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
        <Suspense fallback={<OpenPrsListSkeleton />}>
          <OpenPrsList />
        </Suspense>
      </div>

      <Suspense fallback={<UnresolvedBugsRailSkeleton />}>
        <UnresolvedBugsRail />
      </Suspense>
    </div>
  );
}
