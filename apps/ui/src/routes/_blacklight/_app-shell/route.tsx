import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "lib/auth";
import { currentPathForRedirect } from "lib/auth-redirect";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { ensureOrgStatusData, ensureOrganizationsData, ensureSessionData } from "lib/query/auth.queries";
import type { RouteContext } from "../../__root";
import { AppShellLayout } from "./-layout/app-shell-layout";

export const Route = createFileRoute("/_blacklight/_app-shell")({
  component: AppShell,
  beforeLoad: async (opts) => {
    return getAppShellContext(opts.context, opts.location.pathname);
  },
});

async function getAppShellContext({ queryClient, trpc }: RouteContext, pathname: string) {
  const session = await ensureSessionData(queryClient);
  if (session == null) {
    throw redirect({ to: "/login", search: { error: undefined, redirectTo: currentPathForRedirect(window.location) } });
  }

  const user = session.user;
  const isAdmin = user.role === "admin";

  const activeOrganizationId = session.session.activeOrganizationId;
  if (activeOrganizationId == null) throw redirect({ to: "/pending" });

  // Every app-scoped query on the page is blocked on an id from the application list, and the list
  // needs nothing from the org reads below - so it starts here instead of three round trips down.
  // Started rather than awaited so the redirect checks keep their original order: the read at the
  // bottom resolves from this fetch. It rides the same batched request as `orgStatus`.
  //
  // The session read above deliberately stays serial. Firing org-scoped reads before we know a
  // session exists would turn every signed-out visit to an app URL into a pair of reported 401s.
  void queryClient.prefetchQuery(trpc.applications.list.queryOptions());

  const [organizations, orgStatus] = await Promise.all([
    ensureOrganizationsData(queryClient),
    ensureOrgStatusData(queryClient),
  ]);

  const activeOrganization =
    organizations.find((org) => org.id === activeOrganizationId) ??
    (await queryClient.fetchQuery({ ...trpc.auth.activeOrg.queryOptions(), staleTime: 0 }).catch(() => undefined));
  if (activeOrganization == null) {
    await authClient.signOut();
    queryClient.clear();
    throw redirect({ to: "/login", search: { error: undefined } });
  }

  if (orgStatus === "pending" && !isAdmin) throw redirect({ to: "/pending" });
  if (orgStatus === "rejected" && !isAdmin) throw redirect({ to: "/rejected" });

  // `ensureQueryData`, not `fetchQuery`: the prefetch above already applied the staleness check, so
  // this only has to read its result. `fetchQuery` would re-check and fire a second identical
  // request the moment the prefetch settled first.
  const applications = await queryClient.ensureQueryData(trpc.applications.list.queryOptions());

  // Admins must keep access to /admin even when the active org has no
  // applications - it is the only place to switch orgs. Without this exemption
  // the onboarding redirect below traps them on the create-application screen
  // with no way out.
  const isAdminEscapeHatch = isAdmin && pathname.startsWith("/admin");

  if (applications.length === 0 && !isAdminEscapeHatch) {
    throw redirect({ to: "/onboarding", search: buildOnboardingSearch("add-app") });
  }

  return { user, organizations, activeOrganization, applications };
}

function AppShell() {
  return (
    <AppShellLayout>
      <Outlet />
    </AppShellLayout>
  );
}
