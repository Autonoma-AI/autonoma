import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchData } from "lib/query/branches.queries";
import { setLastApp } from "../-last-app";
import { AppNotFound } from "./-app-not-found";

export const Route = createFileRoute("/_blacklight/_app-shell/app/$appSlug")({
  loader: ({ context, params: { appSlug } }) => {
    const app = context.applications.find((a) => a.slug === appSlug);
    if (app == null) throw notFound();
    setLastApp(app.slug);
    return ensureBranchData(context.queryClient, app.id, app.mainBranch.name);
  },
  notFoundComponent: AppNotFound,
  component: AppLayout,
});

function AppLayout() {
  return <Outlet />;
}
