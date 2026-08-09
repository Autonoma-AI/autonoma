import { Outlet, createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "lib/auth";
import { currentPathForRedirect } from "lib/auth-redirect";
import { buildOnboardingSearch } from "lib/onboarding/onboarding-search";
import { ensureAPIQueryData } from "lib/query/api-queries";
import { ensureOrgStatusData, ensureSessionData } from "lib/query/auth.queries";
import type { RouteContext } from "../../__root";
import { AppShellLayout } from "./-layout/app-shell-layout";
import { AppShellSkeleton } from "./-layout/app-shell-skeleton";

export const Route = createFileRoute("/_blacklight/_app-shell")({
  component: AppShell,
  // The gate below resolves the session, org and application list before anything under the shell can
  // render, and the real Sidebar cannot be shown until it has - so this is the one wait that needs the
  // shell's own silhouette rather than the router's default content skeleton.
  pendingComponent: AppShellSkeleton,
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

  // `auth.activeOrg` is the single description of the organization this session acts as. It used to
  // be read alongside better-auth's `organization.list()`, whose matching entry won - and that is what
  // made renaming appear to do nothing: the sidebar header reads the name from here, `organization.rename`
  // refreshes `activeOrg`, and nothing refreshed better-auth's copy. Two answers to one question, one of
  // them never invalidated. It also carries the server-computed flags this guard needs (`needsNaming`),
  // which the better-auth list does not have.
  const [orgStatus, activeOrganization] = await Promise.all([
    ensureOrgStatusData(queryClient),
    ensureAPIQueryData(queryClient, trpc.auth.activeOrg.queryOptions()),
  ]);

  // The session names an organization that no longer exists, so there is nothing to render it as.
  // Losing a *membership* is not this case: `orgStatus` below reads the member row and sends
  // a non-member to /pending rather than signing them out.
  if (activeOrganization == null) {
    await authClient.signOut();
    queryClient.clear();
    throw redirect({ to: "/login", search: { error: undefined } });
  }

  if (orgStatus === "pending" && !isAdmin) throw redirect({ to: "/pending" });
  if (orgStatus === "rejected" && !isAdmin) throw redirect({ to: "/rejected" });

  // An organization created from a personal email address carries the name of whoever signed up
  // first, who is not necessarily whose organization it is. Ask once, then never again.
  if (activeOrganization.needsNaming) {
    // Confirmed against the server before bouncing, because the `ensureQueryData` above returns
    // whatever is in the cache at that moment. Redirecting on a stale `true` is how this trapped
    // someone on the naming screen: they set a name, the screen navigated here, and this sent them
    // back. The extra read costs a request only on the redirect path, which happens at most once per
    // account - `nameConfirmedAt` is durable.
    const fresh = await queryClient
      .fetchQuery({ ...trpc.auth.activeOrg.queryOptions(), staleTime: 0 })
      .catch(() => activeOrganization);
    if (fresh?.needsNaming === true) {
      throw redirect({ to: "/name-organization", search: { redirectTo: pathname } });
    }
  }

  // `fetchQuery` rather than `ensureQueryData`, and the difference is load-bearing twice over.
  //
  // It has to JOIN the prefetch above, not read around it. `ensureQueryData` returns whatever is in the
  // cache the moment it is called and ignores an in-flight fetch entirely (`queryClient.js`: it only
  // fetches when `cachedData === undefined`). So on any navigation where `orgStatus` is still fresh - the
  // common case, with a 30s staleTime - the `Promise.all` above resolves without a round trip, the
  // prefetch is still flying, and `ensureQueryData` hands back the PREVIOUS application list.
  //
  // That matters because nothing observes `applications.list` inside the shell: every consumer reads
  // `context.applications`, so the `invalidateQueries` calls in `useDeleteApplication`,
  // `useRenameApplication` and `useLinkRepository` only mark the query invalidated - with the default
  // `refetchType: "active"` they refetch nothing. This read is the only thing that picks the change up.
  // Read around the prefetch and deleting an app leaves it in the context array, so the app hub redirects
  // straight back into the app that is gone.
  //
  // It costs no extra request: `query.fetch()` returns the in-flight retryer's promise when a fetch is
  // already running (`query.js:166-176`, and `fetchQuery` passes no `cancelRefetch`), and once the
  // prefetch has settled the data is fresh so the staleness check short-circuits.
  const applications = await queryClient.fetchQuery(trpc.applications.list.queryOptions());

  // Admins must keep access to /admin even when the active org has no
  // applications - it is the only place to switch orgs. Without this exemption
  // the onboarding redirect below traps them on the create-application screen
  // with no way out.
  const isAdminEscapeHatch = isAdmin && pathname.startsWith("/admin");

  if (applications.length === 0 && !isAdminEscapeHatch) {
    throw redirect({ to: "/onboarding", search: buildOnboardingSearch("add-app") });
  }

  return { user, activeOrganization, applications };
}

function AppShell() {
  return (
    <AppShellLayout>
      <Outlet />
    </AppShellLayout>
  );
}
