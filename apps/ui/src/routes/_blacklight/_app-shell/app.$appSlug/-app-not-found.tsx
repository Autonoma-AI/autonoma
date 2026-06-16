import { BrailleSpinner } from "@autonoma/blacklight";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { useOrgByAppSlug, useSwitchToOrg } from "lib/query/admin.queries";
import { useEffect, useRef } from "react";
import { clearLastApp } from "../-last-app";

// Literal route id (instead of importing the Route) to avoid a circular import
// with route.tsx, which renders this component as its notFoundComponent.
const APP_SLUG_ROUTE_ID = "/_blacklight/_app-shell/app/$appSlug";

/**
 * Shown when an application slug is not found in the active organization.
 *
 * Applications are scoped to the active org, so an internal (admin) user opening
 * a deep link shared from another org lands here. Rather than forcing them to
 * open the org switcher manually, we look up which org owns the slug and switch
 * into it automatically, then reload so the deep link resolves.
 *
 * For non-admins (regular customers) the cross-org lookup never runs and the
 * plain "not found" message is shown.
 */
export function AppNotFound() {
  const { appSlug } = useParams({ from: APP_SLUG_ROUTE_ID });
  const { isAdmin, activeOrganizationId } = useAuth();
  const router = useRouter();
  const location = useLocation();

  const lookup = useOrgByAppSlug(appSlug, isAdmin);
  const switchMutation = useSwitchToOrg();
  const hasStartedSwitch = useRef(false);

  const target = lookup.data ?? undefined;
  const shouldSwitch = isAdmin && target != null && target.orgId !== activeOrganizationId;

  useEffect(() => {
    if (!isAdmin || target == null || hasStartedSwitch.current) return;
    if (target.orgId === activeOrganizationId) return;

    hasStartedSwitch.current = true;
    switchMutation.mutate(
      { orgId: target.orgId },
      {
        onSuccess: () => {
          // The app lives in the org we just switched into. The last-viewed app
          // belonged to the previous org, so drop it, then hard-reload the same
          // URL so the session, org list, and applications all re-resolve.
          clearLastApp();
          void router.navigate({ href: location.href, reloadDocument: true });
        },
      },
    );
  }, [isAdmin, target, activeOrganizationId, switchMutation, router, location.href]);

  const isResolving = isAdmin && !switchMutation.isError && (lookup.isPending || shouldSwitch);

  if (isResolving) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <BrailleSpinner />
        <p className="font-mono text-sm text-text-secondary">
          {target != null ? `Switching to ${target.orgName}...` : "Looking for this in your other organizations..."}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col items-center justify-center">
      <h1 className="text-xl font-medium text-text-primary">Application not found</h1>
      <p className="mt-2 font-mono text-sm text-text-secondary">The application you are looking for does not exist.</p>
    </div>
  );
}
