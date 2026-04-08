import { Outlet, createFileRoute, notFound } from "@tanstack/react-router";
import { ensureBranchData } from "lib/query/branches.queries";
import { setLastApp } from "../-last-app";

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

function AppNotFound() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <h1 className="text-xl font-medium text-text-primary">Application not found</h1>
      <p className="mt-2 font-mono text-sm text-text-secondary">The application you are looking for does not exist.</p>
    </div>
  );
}
