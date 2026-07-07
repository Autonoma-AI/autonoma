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
 * a deep link shared from another org lands here. We look up which org(s) own the
 * slug and route accordingly:
 *  - exactly one owner  -> switch into it automatically, then reload so the deep
 *    link resolves.
 *  - several owners (a duplicate / re-onboarded customer whose slug lives in more
 *    than one of the user's orgs) -> show a chooser instead of dead-ending on
 *    "not found".
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

  // Orgs that own this slug, minus the one we're already in (which by definition does not have the app).
  const candidates = (lookup.data ?? []).filter((c) => c.orgId !== activeOrganizationId);
  const soleTarget = candidates.length === 1 ? candidates[0] : undefined;

  // Switch into `orgId`, then hard-reload the same URL so the session, org list, and applications all
  // re-resolve into the org we just entered (the last-viewed app belonged to the previous org).
  const switchInto = (orgId: string) => {
    switchMutation.mutate(
      { orgId },
      {
        onSuccess: () => {
          clearLastApp();
          void router.navigate({ href: location.href, reloadDocument: true });
        },
      },
    );
  };

  // Exactly one owner -> switch automatically. The ref guard prevents a duplicate switch across re-renders.
  useEffect(() => {
    if (!isAdmin || soleTarget == null || hasStartedSwitch.current) return;
    hasStartedSwitch.current = true;
    switchMutation.mutate(
      { orgId: soleTarget.orgId },
      {
        onSuccess: () => {
          clearLastApp();
          void router.navigate({ href: location.href, reloadDocument: true });
        },
      },
    );
  }, [isAdmin, soleTarget, switchMutation, router, location.href]);

  if (!isAdmin) return <NotFoundMessage />;

  if (lookup.isPending) {
    return <Resolving label="Looking for this in your other organizations..." />;
  }

  if (soleTarget != null && !switchMutation.isError) {
    return <Resolving label={`Switching to ${soleTarget.orgName}...`} />;
  }

  if (candidates.length > 1) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-6">
        <div className="text-center">
          <h1 className="text-xl font-medium text-text-primary">Open in which organization?</h1>
          <p className="mt-2 font-mono text-sm text-text-secondary">
            <span className="text-text-primary">{appSlug}</span> exists in {candidates.length} of your organizations.
          </p>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-2">
          {candidates.map((c) => (
            <button
              key={c.orgId}
              type="button"
              disabled={switchMutation.isPending}
              onClick={() => switchInto(c.orgId)}
              className="flex items-center justify-between gap-4 rounded-lg border border-border-dim bg-surface-raised px-4 py-3 text-left transition-colors hover:border-border-highlight hover:bg-surface-base disabled:pointer-events-none disabled:opacity-60"
            >
              <span className="truncate font-medium text-text-primary">{c.orgName}</span>
              <span className="shrink-0 font-mono text-2xs text-text-secondary">{c.orgSlug}</span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <NotFoundMessage />;
}

function Resolving({ label }: { label: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      <BrailleSpinner />
      <p className="font-mono text-sm text-text-secondary">{label}</p>
    </div>
  );
}

function NotFoundMessage() {
  return (
    <div className="flex h-full flex-col items-center justify-center">
      <h1 className="text-xl font-medium text-text-primary">Application not found</h1>
      <p className="mt-2 font-mono text-sm text-text-secondary">The application you are looking for does not exist.</p>
    </div>
  );
}
