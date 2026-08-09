import { BrailleSpinner, Button } from "@autonoma/blacklight";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useAuth } from "lib/auth";
import { useOrgByAppSlug, useSwitchToOrg } from "lib/query/admin.queries";
import { useAppSlugOwners, useSwitchOrganization } from "lib/query/organization.queries";
import { useEffect, useRef } from "react";
import { clearLastAppId } from "../-last-app";

// Literal route id (instead of importing the Route) to avoid a circular import
// with route.tsx, which renders this component as its notFoundComponent.
const APP_SLUG_ROUTE_ID = "/_blacklight/_app-shell/app/$appSlug";

interface Candidate {
  orgId: string;
  orgName: string;
  orgSlug: string;
  /** Staff-only reach: the caller is not a member and joining is part of switching. */
  viaAdmin: boolean;
}

/**
 * Shown when an application slug is not found in the active organization.
 *
 * Application slugs are unique per organization rather than globally, so the same link resolves to a
 * different application - or to nothing - depending on which organization you are acting as. Anyone
 * in more than one organization can be sent a link to an app in the other one, so this looks up where
 * the slug can be opened and routes accordingly:
 *
 *  - exactly one owner -> switch into it and reload, so the deep link resolves
 *  - several owners (the same slug in more than one of your organizations) -> ask which
 *  - none -> a plain "not found"
 *
 * The membership-scoped lookup runs for **everyone**. It used to be admin-only, which meant a
 * customer in two organizations opening a colleague's link just dead-ended. Autonoma staff keep a
 * second, wider fallback: `admin.findOrgByAppSlug` searches every organization and `admin.switchToOrg`
 * grants the membership, which is how internal users open a customer's link they are not part of.
 */
export function AppNotFound() {
  const { appSlug } = useParams({ from: APP_SLUG_ROUTE_ID });
  const { isAdmin, activeOrganizationId } = useAuth();
  const router = useRouter();
  const location = useLocation();

  const mine = useAppSlugOwners(appSlug, true);
  const myCandidates: Candidate[] = (mine.data ?? [])
    .filter((owner) => owner.organizationId !== activeOrganizationId)
    .map((owner) => ({
      orgId: owner.organizationId,
      orgName: owner.organizationName,
      orgSlug: owner.organizationSlug,
      viaAdmin: false,
    }));

  // Only consulted when the caller's own organizations turn up nothing, so a normal
  // multi-organization user never pays for the admin-gated call. `isError` counts as "turned up
  // nothing" on purpose: a transient failure of the member lookup must not also cost staff their
  // wider rescue.
  const needsAdminFallback = isAdmin && (mine.isError || (mine.isSuccess && myCandidates.length === 0));
  const adminLookup = useOrgByAppSlug(appSlug, needsAdminFallback);
  const adminCandidates: Candidate[] = (adminLookup.data ?? [])
    .filter((c) => c.orgId !== activeOrganizationId)
    .map((c) => ({ orgId: c.orgId, orgName: c.orgName, orgSlug: c.orgSlug, viaAdmin: true }));

  const candidates = myCandidates.length > 0 ? myCandidates : adminCandidates;
  const soleTarget = candidates.length === 1 ? candidates[0] : undefined;

  const switchOrganization = useSwitchOrganization({ redirectTo: location.href });
  const adminSwitch = useSwitchToOrg();
  const hasStartedSwitch = useRef(false);

  // Reload the same URL after switching, so the session, organization list and applications all
  // re-resolve into the organization just entered and the deep link finally matches.
  const switchInto = (candidate: Candidate) => {
    clearLastAppId();
    if (!candidate.viaAdmin) {
      // Membership-checked, and persists the choice - same path as the sidebar switcher.
      switchOrganization.mutate({ organizationId: candidate.orgId });
      return;
    }
    adminSwitch.mutate(
      { orgId: candidate.orgId },
      { onSuccess: () => void router.navigate({ href: location.href, reloadDocument: true }) },
    );
  };

  // Exactly one owner -> switch automatically. The ref guard prevents a duplicate switch across re-renders.
  useEffect(() => {
    if (soleTarget == null || hasStartedSwitch.current) return;
    hasStartedSwitch.current = true;
    switchInto(soleTarget);
    // `switchInto` is recreated each render; the ref above is what makes this run once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soleTarget]);

  const isResolving = mine.isPending || (needsAdminFallback && adminLookup.isPending);
  if (isResolving) return <Resolving label="Looking for this in your other organizations..." />;

  // Without this, a network blip renders "Application not found" - which is a lie, and the user has
  // no way to tell it from the app genuinely not existing. Everyone reaches this path now, not just
  // staff, so the wrong answer is worth distinguishing.
  const lookupFailed = mine.isError && (!needsAdminFallback || adminLookup.isError);
  if (lookupFailed && candidates.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4">
        <div className="text-center">
          <h1 className="text-xl font-medium text-text-primary">We couldn't check your organizations</h1>
          <p className="mt-2 font-mono text-sm text-text-secondary">
            <span className="text-text-primary">{appSlug}</span> may exist in another organization - we couldn't reach
            the server to find out.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => {
            void mine.refetch();
            if (needsAdminFallback) void adminLookup.refetch();
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const switchFailed = switchOrganization.isError || adminSwitch.isError;
  if (soleTarget != null && !switchFailed) {
    return <Resolving label={`Switching to ${soleTarget.orgName}...`} />;
  }

  if (candidates.length > 1) {
    const isPending = switchOrganization.isPending || adminSwitch.isPending;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-6 px-6">
        <div className="text-center">
          <h1 className="text-xl font-medium text-text-primary">Open in which organization?</h1>
          <p className="mt-2 font-mono text-sm text-text-secondary">
            <span className="text-text-primary">{appSlug}</span> exists in {candidates.length} of your organizations.
          </p>
        </div>
        <div className="flex w-full max-w-sm flex-col gap-2">
          {candidates.map((candidate) => (
            <button
              key={candidate.orgId}
              type="button"
              disabled={isPending}
              onClick={() => switchInto(candidate)}
              className="flex items-center justify-between gap-4 rounded-lg border border-border-dim bg-surface-raised px-4 py-3 text-left transition-colors hover:border-border-highlight hover:bg-surface-base disabled:pointer-events-none disabled:opacity-60"
            >
              <span className="truncate font-medium text-text-primary">{candidate.orgName}</span>
              <span className="shrink-0 font-mono text-2xs text-text-secondary">{candidate.orgSlug}</span>
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
