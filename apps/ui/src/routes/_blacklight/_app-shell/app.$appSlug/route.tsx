import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { prefetchShellNavState, prefetchShellSuiteHealth } from "lib/query/app-shell.queries";
import { ensureBranchData } from "lib/query/branches.queries";
import { setLastAppId } from "../-last-app";
import { AppNotFound } from "./-app-not-found";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug")({
  loader: ({ context: { queryClient, applications }, params: { appSlug } }) => {
    const app = applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    setLastAppId(app.id);

    // The sidebar renders on every app page but mounts only once these loaders resolve, so its two
    // app-scoped reads would otherwise fire a round trip of their own after the page has painted -
    // the health meter on a skeleton and "Finish setup" popping into the nav a beat late. Started,
    // not awaited: neither gates the page.
    prefetchShellSuiteHealth(queryClient, app.id);
    prefetchShellNavState(queryClient, app.id);

    return ensureBranchData(queryClient, app.id, app.mainBranch.name);
  },
  notFoundComponent: AppNotFound,
  component: AppLayout,
});

function AppLayout() {
  return <Outlet />;
}
