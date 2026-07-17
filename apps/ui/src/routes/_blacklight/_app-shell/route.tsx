import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "lib/auth";
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
  if (session == null) throw redirect({ to: "/login", search: { error: undefined } });

  const user = session.user;
  const isAdmin = user.role === "admin";

  const activeOrganizationId = session.session.activeOrganizationId;
  if (activeOrganizationId == null) throw redirect({ to: "/pending" });

  const organizations = await ensureOrganizationsData(queryClient);

  const activeOrganization =
    organizations.find((org) => org.id === activeOrganizationId) ??
    (await queryClient.fetchQuery({ ...trpc.auth.activeOrg.queryOptions(), staleTime: 0 }).catch(() => undefined));
  if (activeOrganization == null) {
    await authClient.signOut();
    queryClient.clear();
    throw redirect({ to: "/login", search: { error: undefined } });
  }

  const orgStatus = await ensureOrgStatusData(queryClient);
  if (orgStatus === "pending" && !isAdmin) throw redirect({ to: "/pending" });
  if (orgStatus === "rejected" && !isAdmin) throw redirect({ to: "/rejected" });

  const applications = await queryClient.fetchQuery(trpc.applications.list.queryOptions());

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
