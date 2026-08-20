import { Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { ensureApplicationActivityData } from "lib/query/activity.queries";
import { ensureShellNavState, prefetchShellSuiteHealth } from "lib/query/app-shell.queries";
import { ensureBranchData } from "lib/query/branches.queries";
import { setLastAppId } from "../-last-app";
import { AppNotFound } from "./-app-not-found";
import { isSettingsPath } from "./-settings-path";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug")({
  loader: async ({ context: { queryClient, applications }, params: { appSlug }, location }) => {
    const app = applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    setLastAppId(app.id);

    // The sidebar renders on every app page but mounts only once this loader resolves, so its
    // app-scoped read would otherwise fire a round trip of its own after the page has painted,
    // leaving the health meter on a skeleton. Started, not awaited: it does not gate the page.
    prefetchShellSuiteHealth(queryClient, app.id);

    // Onboarding runs as one flow, so an app that has not finished it belongs in that flow rather
    // than in a dashboard whose panels it cannot fill yet - empty tests, no scenarios, a suite meter
    // reading nothing. This is the gate that makes the flow uninterruptible: it catches every way
    // back in, including a bookmark or a typed URL.
    //
    // `navState` rather than the full `getState`: it is the one boolean this needs, it is already
    // routed out of the page batch, and it is the read the shell was deliberately narrowed to. This
    // is the only place the shell awaits a server read, and it is unavoidable - a redirect decided
    // after the dashboard paints is a flash of the screen we are trying to keep people out of.
    if (!isSettingsPath(location.pathname, appSlug)) {
      const navState = await ensureShellNavState(queryClient, app.id).catch(() => undefined);
      if (navState != null && !navState.setupComplete) {
        throw redirect({ to: "/onboarding", search: buildOnboardingSearch(undefined, app.id) });
      }
    }

    // Activity decides what the page content *is* (a zero state or a list), not just how it is decorated, so it
    // is awaited rather than fired and forgotten. It batches with the branch read, so it costs no extra request.
    const [branch] = await Promise.all([
      ensureBranchData(queryClient, app.id, app.mainBranch.name),
      ensureApplicationActivityData(queryClient, app.id),
    ]);
    return branch;
  },
  notFoundComponent: AppNotFound,
  component: AppLayout,
});

function AppLayout() {
  return <Outlet />;
}
