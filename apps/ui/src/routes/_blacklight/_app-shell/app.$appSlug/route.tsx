import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchData } from "lib/query/branches.queries";
import { prefetchSuiteHealth } from "lib/query/suite-health.queries";
import { trpc } from "lib/trpc";
import { setLastApp } from "../-last-app";
import { AppNotFound } from "./-app-not-found";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug")({
  loader: ({ context: { queryClient, applications }, params: { appSlug } }) => {
    const app = applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    setLastApp(app.slug);

    // The sidebar renders on every app page but mounts only once these loaders resolve, so its two
    // app-scoped reads would otherwise fire a round trip of their own after the page has painted -
    // the health meter on a skeleton and "Finish setup" popping into the nav a beat late. Started,
    // not awaited: neither gates the page.
    prefetchSuiteHealth(queryClient, app.id);
    void queryClient.prefetchQuery(trpc.onboarding.getState.queryOptions({ applicationId: app.id }));

    return ensureBranchData(queryClient, app.id, app.mainBranch.name);
  },
  notFoundComponent: AppNotFound,
  component: AppLayout,
});

function AppLayout() {
  return <Outlet />;
}
